/**
 * connect_request pacing (group D): invite accounting, inter-action spacing, and
 * the daily/weekly caps. Pacing runs before the driver, so turning the note off
 * must not buy extra quota. Skips without Redis + Postgres (see CLAUDE.md for
 * local services). One throwaway workspace and account; no LinkedIn traffic.
 */
import Redis from 'ioredis';
import { PacingService } from '@/modules/engine/pacing.service';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { assertLocalServices } from './local-only';

const WS = '00000000-0000-0000-0000-0000000000d1';
const ACCT = '00000000-0000-0000-0000-0000000000d2';
const KEY_PREFIX = `pacing:linkedin:${ACCT}`;

let redis: Redis;
let pacing: PacingService;
let reachable = false;
let skipReason = '';

/** Delete every pacing key this suite could have created for the test account. */
async function clearPacingKeys() {
  const keys = await redis.keys(`${KEY_PREFIX}*`);
  if (keys.length) await redis.del(...keys);
}

beforeAll(async () => {
  // --- Step 1: connectivity only. Unreachable infra SKIPS the suite. ---
  try {
    assertLocalServices(getEnv());
    redis = new Redis(getEnv().REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 4000,
    });
    redis.on('error', () => undefined); // don't let a dead socket crash the run
    await redis.connect();
    await redis.ping();
    await getDb().selectFrom('workspaces').select('id').limit(1).execute();
    reachable = true;
  } catch (e: any) {
    skipReason = e?.message || String(e);
    console.warn(`\n[connect-no-note-pacing] SKIPPED — Redis/DB unreachable: ${skipReason}`);
    console.warn('[connect-no-note-pacing] start Redis with: docker run -d -p 6379:6379 redis:7-alpine\n');
    return;
  }

  // --- Step 2: seeding. Not caught: a broken fixture must fail, not skip. ---

  // Workspaces is NOT RLS'd — insert directly.
  await getDb()
    .insertInto('workspaces')
    .values({ id: WS, name: 'TEST connect pacing', goal: 'automated test' } as any)
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // Wide-open hours + weekends so only the gate under test can block.
  // warmup_daily_limit has a CHECK ceiling of 45.
  await withWorkspace(WS, (db) =>
    db
      .insertInto('linkedin_accounts')
      .values({
        id: ACCT,
        workspace_id: WS,
        email: 'connect-pacing-test@example.invalid',
        country: 'IN',
        status: 'active',
        warmup_daily_limit: 45,
        warmup_target: 45,
        weekly_invite_cap: 100,
        hours_start: '00:00',
        hours_end: '23:59',
        send_weekends: true,
        timezone: 'UTC',
        // Backdated so the warm-up ramp can't be what blocks.
        connected_at: new Date(Date.now() - 120 * 86400_000).toISOString(),
      } as any)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute(),
  );

  pacing = new PacingService();
}, 60_000);

afterAll(async () => {
  if (reachable) {
    await clearPacingKeys().catch(() => undefined);
    await withWorkspace(WS, (db) =>
      db.deleteFrom('linkedin_accounts').where('id', '=', ACCT).execute(),
    ).catch(() => undefined);
    await getDb().deleteFrom('workspaces').where('id', '=', WS).execute().catch(() => undefined);
  }
  await redis?.quit().catch(() => undefined);
  await getDb().destroy().catch(() => undefined);
}, 30_000);

beforeEach(async () => {
  if (reachable) await clearPacingKeys();
});

/** Marks each test skipped (not failed) when the infra isn't there. */
const t = (name: string, fn: () => Promise<void>, timeout?: number) =>
  it(
    name,
    async () => {
      if (!reachable) {
        console.warn(`  ↳ skipped (${skipReason})`);
        return;
      }
      await fn();
    },
    timeout,
  );

describe('Connect request — pacing gates (no-note connects are paced identically)', () => {
  t('D1: the first connect request of the day is allowed', async () => {
    const res = await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);
    expect(res.allowed).toBe(true);
  });

  t('D2: a second connect immediately after the first is deferred by spacing', async () => {
    const first = await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);
    expect(first.allowed).toBe(true);

    const second = await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);
    expect(second.allowed).toBe(false);
    expect(second.nextScheduledAt).toBeTruthy();
  });

  t('D3: the enforced spacing gap is within the human range (90s–20 min)', async () => {
    const before = Date.now();
    await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);
    const deferred = await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);

    expect(deferred.allowed).toBe(false);
    const gapMin = (new Date(deferred.nextScheduledAt!).getTime() - before) / 60_000;
    // `before` was captured pre-send, so timing slop can only shrink the gap.
    expect(gapMin).toBeGreaterThanOrEqual(1.4);
    expect(gapMin).toBeLessThanOrEqual(20.1);
  });

  t('D4: a spacing deferral does NOT consume a daily slot', async () => {
    await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true); // consumes 1
    const dailyAfterFirst = await redis.keys(`${KEY_PREFIX}:date:*:daily`);
    const countAfterFirst = Number(await redis.get(dailyAfterFirst[0]));

    await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true); // deferred by spacing
    const countAfterDefer = Number(await redis.get(dailyAfterFirst[0]));

    // Spacing is checked before the daily counter, so a deferred send uses no quota.
    expect(countAfterDefer).toBe(countAfterFirst);
  });

  t('D5: only connect_request consumes the weekly invite allowance', async () => {
    await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true); // invite
    const afterInvite = Number((await redis.get(`${KEY_PREFIX}:weekly`)) || 0);
    expect(afterInvite).toBe(1);

    // Non-invite actions use the daily counter only, not the weekly invite cap.
    await redis.del(`${KEY_PREFIX}:nextallowed`); // bypass spacing to isolate the weekly counter
    await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, false); // isInvite=false
    const afterFollow = Number((await redis.get(`${KEY_PREFIX}:weekly`)) || 0);

    expect(afterFollow).toBe(1);
  });

  t('D6: release() gives back both the daily and the weekly invite slot', async () => {
    await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);
    const dailyKeys = await redis.keys(`${KEY_PREFIX}:date:*:daily`);
    const dailyBefore = Number(await redis.get(dailyKeys[0]));
    const weeklyBefore = Number(await redis.get(`${KEY_PREFIX}:weekly`));

    // release() runs when a job defers or fails, so a retry isn't double-counted.
    await pacing.release(ACCT, 'linkedin', WS, true);

    expect(Number(await redis.get(dailyKeys[0]))).toBe(dailyBefore - 1);
    expect(Number(await redis.get(`${KEY_PREFIX}:weekly`))).toBe(weeklyBefore - 1);
  });

  t('D7: the weekly invite cap blocks further connects once exhausted', async () => {
    // Pre-load the weekly counter to the cap so the very next invite is over it.
    await redis.set(`${KEY_PREFIX}:weekly`, '100');

    const res = await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);

    expect(res.allowed).toBe(false);
    expect(res.nextScheduledAt).toBeTruthy();
    // Rolled back — a blocked invite must not leave the counter above the cap.
    expect(Number(await redis.get(`${KEY_PREFIX}:weekly`))).toBe(100);
  });

  t('D8: the spacing gap is deterministic for the same account+day', async () => {
    await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);
    const a = await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);
    const b = await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, true);

    // Same account + day ⇒ same gap, so re-checks don't drift.
    expect(a.nextScheduledAt).toBe(b.nextScheduledAt);
  });
  /**
   * Run N actions back to back and return each chosen gap (minutes). Only the
   * spacing key is cleared; the daily counter is the roll's seed and must advance.
   */
  async function sampleGaps(n: number): Promise<number[]> {
    const gaps: number[] = [];
    for (let i = 0; i < n; i++) {
      await redis.del(`${KEY_PREFIX}:nextallowed`);
      const before = Date.now();
      const res = await pacing.checkPacingAndRegister(ACCT, 'linkedin', WS, false);
      expect(res.allowed).toBe(true);
      const nextAllowed = Number(await redis.get(`${KEY_PREFIX}:nextallowed`));
      gaps.push((nextAllowed - before) / 60_000);
    }
    return gaps;
  }

  t('D9: the gap is re-rolled per action, not fixed for the whole day', async () => {
    const gaps = await sampleGaps(40);

    // A gap that's constant all day is itself a fingerprint.
    expect(new Set(gaps.map((g) => g.toFixed(2))).size).toBeGreaterThan(5);
  }, 30_000);

  t('D10: every rolled gap stays inside the human range (90s–20 min)', async () => {
    const gaps = await sampleGaps(40);

    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(1.4);
      expect(g).toBeLessThanOrEqual(20.1);
    }
  }, 30_000);

  t('D11: the rhythm mixes quick follow-ups with occasional long pauses', async () => {
    const gaps = await sampleGaps(40);

    // Humans sometimes act twice within two minutes, then step away for longer.
    expect(Math.min(...gaps)).toBeLessThan(3);
    expect(Math.max(...gaps)).toBeGreaterThan(7);
  }, 30_000);
});
