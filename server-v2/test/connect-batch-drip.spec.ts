/**
 * Auto Connect — the MAIN batch flow (100 profiles in one shot).
 *
 * THE BEHAVIOUR UNDER TEST
 *   Upload 100 profiles at once, with an account whose daily slot is 20:
 *     • 20 go out TODAY   (status 'queued', pushed to BullMQ immediately)
 *     • the other 80 are spread over the FOLLOWING days, 20/day
 *       (status 'scheduled' — the scheduler tick drains them on their day)
 *   → 5 calendar days total, 20 per day, nothing lost and nothing bursting.
 *
 * WHY IT MATTERS
 *   Day-one is the only part that enqueues inline. Everything after day one
 *   depends on the scheduler tick, so a regression there silently strands 80
 *   invites as rows nobody ever runs. E4 below proves a later day's jobs really
 *   are picked up, rather than just asserting the rows exist.
 *
 * REQUIREMENTS: reachable Postgres + Redis. Suite SKIPS if unreachable.
 *
 * SAFETY — read before changing this file:
 *   • createBatch() and the scheduler both ENQUEUE to BullMQ for real. This
 *     suite therefore REFUSES TO RUN unless REDIS_URL points at localhost, so a
 *     stray run can never push invites onto the production queue that the live
 *     worker consumes. Do not weaken that guard.
 *   • No LinkedIn traffic occurs: nothing here runs a driver. We only assert on
 *     rows and queue state.
 *   • All rows live in one throwaway workspace, deleted in afterAll.
 */
import Redis from 'ioredis';
import { JobsService } from '@/modules/jobs/jobs.service';
import { SchedulerService } from '@/modules/engine/scheduler.service';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { assertLocalServices } from './local-only';

const WS = '00000000-0000-0000-0000-0000000000f1';
const ACCT = '00000000-0000-0000-0000-0000000000f2';

const TOTAL = 100;
const PER_DAY = 20; // the account's warm-up todayLimit, set up below
const EXPECTED_DAYS = TOTAL / PER_DAY; // 5

let jobs: JobsService;
let scheduler: SchedulerService;
let redis: Redis;
let reachable = false;
let skipReason = '';

/** 100 fake profiles, exactly the shape the Auto Connect screen posts. */
const makeRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Test Prospect ${i + 1}`,
    target: `https://www.linkedin.com/in/batch-drip-test-${i + 1}/`,
    company: `Company ${i + 1}`,
    role: 'Engineer',
  }));

/** YYYY-MM-DD of an instant, in the account timezone (UTC for this fixture). */
const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

const allJobs = () =>
  withWorkspace(WS, (db) =>
    db
      .selectFrom('jobs')
      .select(['id', 'status', 'action', 'kind', 'scheduled_for', 'payload'])
      .where('workspace_id', '=', WS)
      .orderBy('scheduled_for', 'asc')
      .execute(),
  );

beforeAll(async () => {
  try {
    assertLocalServices(getEnv());
    redis = new Redis(getEnv().REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 4000,
    });
    redis.on('error', () => undefined);
    await redis.connect();
    await redis.ping();
    await getDb().selectFrom('workspaces').select('id').limit(1).execute();
    reachable = true;
  } catch (e: any) {
    skipReason = e?.message || String(e);
    console.warn(`\n[connect-batch-drip] SKIPPED — ${skipReason}\n`);
    return;
  }

  // Seeding is deliberately un-caught: a broken fixture must fail, not skip.
  await getDb()
    .insertInto('workspaces')
    .values({ id: WS, name: 'TEST batch drip', goal: 'automated test' } as any)
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // warmup_target 20 + connected 60 days ago ⇒ the ramp is long finished and
  // computeWarmup().todayLimit is exactly 20 — the "20 slots today" premise.
  await withWorkspace(WS, (db) =>
    db
      .insertInto('linkedin_accounts')
      .values({
        id: ACCT,
        workspace_id: WS,
        email: 'batch-drip-test@example.invalid',
        country: 'IN',
        status: 'active',
        warmup_daily_limit: 20,
        warmup_target: PER_DAY,
        weekly_invite_cap: 100,
        hours_start: '09:00',
        hours_end: '18:00',
        send_weekends: true,
        timezone: 'UTC', // UTC keeps the per-day assertions deterministic
        connected_at: new Date(Date.now() - 60 * 86400_000).toISOString(),
      } as any)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute(),
  );

  jobs = new JobsService();
  scheduler = new SchedulerService();
}, 120_000);

afterAll(async () => {
  if (reachable) {
    await withWorkspace(WS, (db) =>
      db.deleteFrom('jobs').where('workspace_id', '=', WS).execute(),
    ).catch(() => undefined);
    await withWorkspace(WS, (db) =>
      db.deleteFrom('activity').where('workspace_id', '=', WS).execute(),
    ).catch(() => undefined);
    await withWorkspace(WS, (db) =>
      db.deleteFrom('linkedin_accounts').where('id', '=', ACCT).execute(),
    ).catch(() => undefined);
    await getDb().deleteFrom('workspaces').where('id', '=', WS).execute().catch(() => undefined);

    // Drop anything this suite pushed onto the LOCAL queue.
    await redis?.del('bull:linkedin-actions:meta').catch(() => undefined);
    const keys = await redis?.keys('bull:linkedin-actions:*').catch(() => []);
    if (keys?.length) await redis.del(...keys).catch(() => undefined);
  }
  await redis?.quit().catch(() => undefined);
  await (scheduler as any)?.redis?.quit?.().catch(() => undefined);
  await (scheduler as any)?.linkedinQueue?.close?.().catch(() => undefined);
  await (scheduler as any)?.emailQueue?.close?.().catch(() => undefined);
  await getDb().destroy().catch(() => undefined);
}, 120_000);

const t = (name: string, fn: () => Promise<void>, timeout = 180_000) =>
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

describe('Auto Connect — 100 profiles in one shot, 20/day drip', () => {
  let created: { batchId: string; total: number; today: number; queuedDays: number };

  t('F1: createBatch reports 100 total, 20 today, spread over 5 days', async () => {
    created = await jobs.createBatch(
      WS,
      'linkedin',
      999, // deliberately absurd client cap — see F2
      makeRows(TOTAL),
      'Hi {{firstName}}',
      undefined,
      { noNote: true }, // the note-less connect flow
    );

    expect(created.total).toBe(TOTAL);
    expect(created.today).toBe(PER_DAY);
    expect(created.queuedDays).toBe(EXPECTED_DAYS);
  });

  t('F2: the client-sent cap is IGNORED — the account warm-up limit wins', async () => {
    // We passed cap=999 above. If the client cap were honoured, all 100 would
    // have gone out today. Settings → LinkedIn limits must stay the only place
    // the daily ceiling is controlled.
    expect(created.today).toBe(PER_DAY);
    expect(created.today).not.toBe(TOTAL);
  });

  t('F3: exactly 20 rows are queued for today, 80 scheduled for later', async () => {
    const rows = await allJobs();
    expect(rows).toHaveLength(TOTAL);

    const queued = rows.filter((r) => r.status === 'queued');
    const scheduled = rows.filter((r) => r.status === 'scheduled');

    expect(queued).toHaveLength(PER_DAY);
    expect(scheduled).toHaveLength(TOTAL - PER_DAY);

    // Every row is a LinkedIn connection request carrying the no-note flag.
    for (const r of rows) {
      expect(r.kind).toBe('linkedin');
      expect(r.action).toBe('connect_request');
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      expect(payload.noNote).toBe(true);
    }
  });

  t('F4: the 100 jobs land 20-per-day across 5 consecutive days', async () => {
    const rows = await allJobs();

    const byDay = new Map<string, number>();
    for (const r of rows) {
      const k = dayKey(r.scheduled_for as any);
      byDay.set(k, (byDay.get(k) || 0) + 1);
    }

    const days = [...byDay.keys()].sort();
    expect(days).toHaveLength(EXPECTED_DAYS);
    for (const d of days) expect(byDay.get(d)).toBe(PER_DAY);

    // Consecutive calendar days, no gaps.
    for (let i = 1; i < days.length; i++) {
      const gapDays =
        (new Date(days[i]).getTime() - new Date(days[i - 1]).getTime()) / 86400_000;
      expect(gapDays).toBe(1);
    }

    // Day one is today; everything else is in the future.
    expect(days[0]).toBe(dayKey(new Date()));
  });

  t("F5: each day's 20 become due together at the working-hours open", async () => {
    const rows = await allJobs();

    // Take a future day (day 2) so "already past" day-one times don't muddy it.
    const targetDay = dayKey(new Date(Date.now() + 2 * 86400_000));
    const times = rows
      .filter((r) => dayKey(r.scheduled_for as any) === targetDay)
      .map((r) => new Date(r.scheduled_for as any))
      .sort((a, b) => a.getTime() - b.getTime());

    expect(times).toHaveLength(PER_DAY);

    const hourOf = (d: Date) => d.getUTCHours() + d.getUTCMinutes() / 60;
    // The whole day's quota is RELEASED at the window open (09:00 here) rather
    // than pinned to a slot grid across the window. The grid was written for a
    // cloud executor; ours is the user's laptop, and a job pinned to 15:40 only
    // sends if the laptop happens to be open at 15:40. Releasing the quota at the
    // open lets pacing drain it whenever the machine is actually on — the user
    // opens the laptop once, the queue empties, they close it again.
    for (const d of times) expect(hourOf(d)).toBe(9);
    expect(new Set(times.map((d) => d.getTime())).size).toBe(1);
  });

  t('F6: a LATER day\'s jobs are actually picked up by the scheduler when due', async () => {
    // This is the heart of "the rest send automatically". Simulate day 2
    // arriving by back-dating that day's 20 rows, then run one scheduler pass.
    const rows = await allJobs();
    const targetDay = dayKey(new Date(Date.now() + 2 * 86400_000));
    const dayTwoIds = rows
      .filter((r) => dayKey(r.scheduled_for as any) === targetDay)
      .map((r) => r.id);
    expect(dayTwoIds).toHaveLength(PER_DAY);

    await withWorkspace(WS, (db) =>
      db
        .updateTable('jobs')
        .set({ scheduled_for: new Date(Date.now() - 60_000).toISOString() as any })
        .where('id', 'in', dayTwoIds)
        .execute(),
    );

    // drainWorkspace, never tick() — tick() would drain EVERY workspace and
    // could enqueue real invites for real accounts.
    const res = await (scheduler as any).drainWorkspace(WS);

    expect(res.enqueued).toBe(PER_DAY);

    // The scheduler claims each row (scheduled → queued) before enqueuing, so
    // a restart or a concurrent tick cannot double-send them.
    const after = await allJobs();
    const stillScheduledOnThatDay = after.filter(
      (r) => dayTwoIds.includes(r.id) && r.status === 'scheduled',
    );
    expect(stillScheduledOnThatDay).toHaveLength(0);
    for (const id of dayTwoIds) {
      expect(after.find((r) => r.id === id)?.status).toBe('queued');
    }
  });

  t('F7: future days are left alone — only the due day is drained', async () => {
    const rows = await allJobs();
    // Days 3 and 4 are still in the future and must remain untouched.
    const future = rows.filter(
      (r) => new Date(r.scheduled_for as any).getTime() > Date.now() + 86400_000,
    );
    expect(future.length).toBeGreaterThan(0);
    for (const r of future) expect(r.status).toBe('scheduled');
  });
});

/**
 * createBatch() dedupe — already-invited profiles are dropped from a new
 * upload before any rows are queued.
 *
 * WHY IT MATTERS
 *   The dedupe reads prior SENT connect_request jobs and builds its
 *   exclusion set from BOTH payload fields (`target`, the URL we were given,
 *   and `resolvedSlug`, the vanity slug LinkedIn actually landed on — see
 *   profile-key.ts). A regression that drops the workspace_id predicate would
 *   leak another tenant's sent history into this one's exclusion set; a
 *   regression that breaks the "everything skipped" early return would fall
 *   through to crypto.randomUUID() and mint a batch for zero rows. This
 *   suite uses its own throwaway workspace/account so it never collides with
 *   the drip suite above.
 */
const WS2 = '00000000-0000-0000-0000-0000000000f3';
const ACCT2 = '00000000-0000-0000-0000-0000000000f4';
const OTHER_WS = '00000000-0000-0000-0000-0000000000f5';

let jobs2: JobsService;
let redis2: Redis;
let reachable2 = false;
let skipReason2 = '';

const t2 = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
  it(
    name,
    async () => {
      if (!reachable2) {
        console.warn(`  ↳ skipped (${skipReason2})`);
        return;
      }
      await fn();
    },
    timeout,
  );

describe('createBatch — already-invited profiles are excluded from a new upload', () => {
  beforeAll(async () => {
    try {
      assertLocalServices(getEnv());
      // G1/G3 both produce a "today: 1" job, which createBatch pushes onto
      // BullMQ for real (new Redis(...) with maxRetriesPerRequest: null does
      // NOT fail fast). Without this check, Postgres-up-but-Redis-down would
      // hang this suite against an unreachable queue instead of skipping —
      // mirrors the F-suite's reachability check above.
      redis2 = new Redis(getEnv().REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        connectTimeout: 4000,
      });
      redis2.on('error', () => undefined);
      await redis2.connect();
      await redis2.ping();
      await getDb().selectFrom('workspaces').select('id').limit(1).execute();
      reachable2 = true;
    } catch (e: any) {
      skipReason2 = e?.message || String(e);
      console.warn(`\n[connect-batch-drip:dedupe] SKIPPED — ${skipReason2}\n`);
      return;
    }

    await getDb()
      .insertInto('workspaces')
      .values([
        { id: WS2, name: 'TEST dedupe', goal: 'automated test' } as any,
        { id: OTHER_WS, name: 'TEST dedupe (other tenant)', goal: 'automated test' } as any,
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // warmup_target well above the 3 rows this suite sends, so nothing spills
    // into a second day and every kept row is "today" — keeps assertions simple.
    await withWorkspace(WS2, (db) =>
      db
        .insertInto('linkedin_accounts')
        .values({
          id: ACCT2,
          workspace_id: WS2,
          email: 'dedupe-test@example.invalid',
          country: 'IN',
          status: 'active',
          warmup_daily_limit: 50,
          warmup_target: 50,
          weekly_invite_cap: 100,
          hours_start: '09:00',
          hours_end: '18:00',
          send_weekends: true,
          timezone: 'UTC',
          connected_at: new Date(Date.now() - 60 * 86400_000).toISOString(),
        } as any)
        .onConflict((oc) => oc.column('id').doNothing())
        .execute(),
    );

    jobs2 = new JobsService();
  }, 60_000);

  afterAll(async () => {
    if (reachable2) {
      await withWorkspace(WS2, (db) =>
        db.deleteFrom('jobs').where('workspace_id', '=', WS2).execute(),
      ).catch(() => undefined);
      await withWorkspace(WS2, (db) =>
        db.deleteFrom('activity').where('workspace_id', '=', WS2).execute(),
      ).catch(() => undefined);
      await withWorkspace(WS2, (db) =>
        db.deleteFrom('linkedin_accounts').where('id', '=', ACCT2).execute(),
      ).catch(() => undefined);
      await withWorkspace(OTHER_WS, (db) =>
        db.deleteFrom('jobs').where('workspace_id', '=', OTHER_WS).execute(),
      ).catch(() => undefined);
      await getDb()
        .deleteFrom('workspaces')
        .where('id', 'in', [WS2, OTHER_WS])
        .execute()
        .catch(() => undefined);
    }
    await redis2?.quit().catch(() => undefined);
  }, 60_000);

  t2('G1: a row matching a SENT job by target URL is excluded, and skipped counts it', async () => {
    // Pre-seed a sent connect_request whose payload.target is the profile the
    // new upload will also carry.
    await withWorkspace(WS2, (db) =>
      db
        .insertInto('jobs')
        .values({
          id: crypto.randomUUID(),
          workspace_id: WS2,
          kind: 'linkedin',
          action: 'connect_request',
          status: 'sent',
          scheduled_for: new Date(Date.now() - 86400_000).toISOString() as any,
          payload: JSON.stringify({
            name: 'Already Invited',
            target: 'https://www.linkedin.com/in/already-invited/',
          }),
        } as any)
        .execute(),
    );

    const rows = [
      { name: 'Already Invited', target: 'https://www.linkedin.com/in/already-invited/' },
      { name: 'Fresh Prospect', target: 'https://www.linkedin.com/in/fresh-prospect/' },
    ];

    const result = await jobs2.createBatch(WS2, 'linkedin', 999, rows, 'Hi {{firstName}}', undefined, {
      noNote: true,
    });

    // Would fail if the dedupe were removed: total/today would be 2, skipped 0.
    expect(result.skipped).toBe(1);
    expect(result.total).toBe(1);
    expect(result.today).toBe(1);
    expect(result.batchId).toBeTruthy();

    const created = await withWorkspace(WS2, (db) =>
      db
        .selectFrom('jobs')
        .select(['payload'])
        .where('workspace_id', '=', WS2)
        .where('batch_id', '=', result.batchId)
        .execute(),
    );
    expect(created).toHaveLength(1);
    const p = typeof created[0].payload === 'string' ? JSON.parse(created[0].payload as any) : created[0].payload;
    expect((p as any).target).toBe('https://www.linkedin.com/in/fresh-prospect/');
  });

  t2('G2: a row matching a SENT job only by resolvedSlug is also excluded', async () => {
    // The sent job's payload.target was an obfuscated URN; LinkedIn resolved it
    // to a readable slug at send time, recorded as payload.resolvedSlug. A later
    // upload carrying that readable URL must still be recognised as the same
    // person (this is exactly what Task 4's resolvedSlug field exists for).
    await withWorkspace(WS2, (db) =>
      db
        .insertInto('jobs')
        .values({
          id: crypto.randomUUID(),
          workspace_id: WS2,
          kind: 'linkedin',
          action: 'connect_request',
          status: 'sent',
          scheduled_for: new Date(Date.now() - 86400_000).toISOString() as any,
          payload: JSON.stringify({
            name: 'Resolved Slug Person',
            target: 'https://www.linkedin.com/in/ACwAADY3-obfuscated-urn/',
            resolvedSlug: 'https://www.linkedin.com/in/resolved-slug-person/',
          }),
        } as any)
        .execute(),
    );

    const rows = [
      { name: 'Resolved Slug Person', target: 'https://www.linkedin.com/in/resolved-slug-person/' },
    ];

    const result = await jobs2.createBatch(WS2, 'linkedin', 999, rows, 'Hi {{firstName}}', undefined, {
      noNote: true,
    });

    expect(result.skipped).toBe(1);
    expect(result.total).toBe(0);
    expect(result.batchId).toBe('');
  });

  t2('G3: workspace scoping — a SENT job in another tenant never excludes this one\'s rows', async () => {
    await withWorkspace(OTHER_WS, (db) =>
      db
        .insertInto('jobs')
        .values({
          id: crypto.randomUUID(),
          workspace_id: OTHER_WS,
          kind: 'linkedin',
          action: 'connect_request',
          status: 'sent',
          scheduled_for: new Date(Date.now() - 86400_000).toISOString() as any,
          payload: JSON.stringify({
            name: 'Other Tenant Contact',
            target: 'https://www.linkedin.com/in/cross-tenant-prospect/',
          }),
        } as any)
        .execute(),
    );

    const rows = [
      { name: 'Cross Tenant Prospect', target: 'https://www.linkedin.com/in/cross-tenant-prospect/' },
    ];

    // Same URL was marked SENT in OTHER_WS, but this call runs as WS2 — a
    // dropped workspace_id predicate would incorrectly exclude it here.
    const result = await jobs2.createBatch(WS2, 'linkedin', 999, rows, 'Hi {{firstName}}', undefined, {
      noNote: true,
    });

    expect(result.skipped).toBe(0);
    expect(result.total).toBe(1);
    expect(result.batchId).toBeTruthy();
  });

  t2('G4: every row already contacted — early return with skipped=N, no throw, no batch id', async () => {
    const target = 'https://www.linkedin.com/in/all-skipped-prospect/';
    await withWorkspace(WS2, (db) =>
      db
        .insertInto('jobs')
        .values({
          id: crypto.randomUUID(),
          workspace_id: WS2,
          kind: 'linkedin',
          action: 'connect_request',
          status: 'sent',
          scheduled_for: new Date(Date.now() - 86400_000).toISOString() as any,
          payload: JSON.stringify({ name: 'All Skipped', target }),
        } as any)
        .execute(),
    );

    const rows = [{ name: 'All Skipped', target }];

    // If the early return were broken and fell through to the empty-input
    // guard, this would throw BadRequestException instead of resolving.
    const result = await jobs2.createBatch(WS2, 'linkedin', 999, rows, 'Hi {{firstName}}', undefined, {
      noNote: true,
    });

    expect(result).toEqual({ batchId: '', total: 0, today: 0, queuedDays: 0, skipped: 1 });

    // And no batch id means no rows were inserted at all.
    const anyRowsForThisUpload = await withWorkspace(WS2, (db) =>
      db
        .selectFrom('jobs')
        .select(['id'])
        .where('workspace_id', '=', WS2)
        .where('status', '!=', 'sent')
        .execute(),
    );
    expect(anyRowsForThisUpload).toHaveLength(0);
  });
});
