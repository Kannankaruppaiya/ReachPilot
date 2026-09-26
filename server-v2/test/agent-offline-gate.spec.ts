/**
 * Scheduler desktop-agent gate (group G): in remote mode, a due job whose laptop
 * is offline is deferred by the scheduler before reaching BullMQ, keeping
 * `last_error='agent_unavailable'` for AgentController's wake-on-reconnect.
 * Skips without Postgres + Redis.
 *
 * Safety: uses the private drainWorkspace(testWorkspace), never tick(), which
 * would drain every workspace. G2 enqueues for real, so the suite refuses to run
 * unless REDIS_URL is local. One throwaway workspace.
 */

// Before anything calls getEnv() (it caches); the gate only applies in remote mode.
process.env.LINKEDIN_DRIVER = 'remote';

import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { SchedulerService } from '@/modules/engine/scheduler.service';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { assertLocalServices } from './local-only';

// 'a1'/'a2' — the c1/d1/e1/f1 slots are taken by the other suites.
const WS = '00000000-0000-0000-0000-0000000000a1';
const ACCT = '00000000-0000-0000-0000-0000000000a2';

let scheduler: SchedulerService;
let redis: Redis;
let reachable = false;
let skipReason = '';

/** Drain ONLY the test workspace. See the safety note above — never tick(). */
const drainTestWorkspace = () => (scheduler as any).drainWorkspace(WS);

const pastIso = () => new Date(Date.now() - 60_000).toISOString();

async function seedJob(kind: 'linkedin' | 'email' = 'linkedin'): Promise<string> {
  const id = randomUUID();
  await withWorkspace(WS, (db) =>
    db
      .insertInto('jobs')
      .values({
        id,
        workspace_id: WS,
        kind,
        action: kind === 'linkedin' ? 'connect_request' : 'send_email',
        status: 'scheduled',
        scheduled_for: pastIso(),
        // No lead_id keeps the suppression and duplicate-invite gates out of the way.
        lead_id: null,
        linkedin_account_id: kind === 'linkedin' ? ACCT : null,
        payload: JSON.stringify({ name: 'Test Prospect', noNote: true }),
      } as any)
      .execute(),
  );
  return id;
}

const readJob = (id: string) =>
  withWorkspace(WS, (db) =>
    db
      .selectFrom('jobs')
      .select(['status', 'last_error', 'scheduled_for'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );

const setAgentOnline = () => redis.set(`agent:hb:${ACCT}`, '1', 'EX', 30);
const setAgentOffline = () => redis.del(`agent:hb:${ACCT}`);

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
    console.warn(`\n[agent-offline-gate] SKIPPED — Redis/DB unreachable: ${skipReason}\n`);
    return;
  }

  // Seeding is intentionally un-caught: a broken fixture must fail, not skip.
  await getDb()
    .insertInto('workspaces')
    .values({ id: WS, name: 'TEST agent gate', goal: 'automated test' } as any)
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await withWorkspace(WS, (db) =>
    db
      .insertInto('linkedin_accounts')
      .values({
        id: ACCT,
        workspace_id: WS,
        email: 'agent-gate-test@example.invalid',
        country: 'IN',
        // 'active' so the account-health gate can never be the thing that defers.
        status: 'active',
        warmup_daily_limit: 45,
        warmup_target: 45,
        hours_start: '00:00',
        hours_end: '23:59',
        send_weekends: true,
        timezone: 'UTC',
        connected_at: new Date(Date.now() - 120 * 86400_000).toISOString(),
      } as any)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute(),
  );

  scheduler = new SchedulerService();
}, 60_000);

afterAll(async () => {
  if (reachable) {
    await withWorkspace(WS, (db) => db.deleteFrom('jobs').where('workspace_id', '=', WS).execute()).catch(
      () => undefined,
    );
    await withWorkspace(WS, (db) =>
      db.deleteFrom('linkedin_accounts').where('id', '=', ACCT).execute(),
    ).catch(() => undefined);
    await getDb().deleteFrom('workspaces').where('id', '=', WS).execute().catch(() => undefined);
    await setAgentOffline().catch(() => undefined);
  }
  await redis?.quit().catch(() => undefined);
  await getDb().destroy().catch(() => undefined);
}, 30_000);

beforeEach(async () => {
  if (!reachable) return;
  await withWorkspace(WS, (db) => db.deleteFrom('jobs').where('workspace_id', '=', WS).execute());
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

describe('Scheduler — desktop-agent gate (remote driver)', () => {
  t('G1: with the laptop off, a due job is deferred instead of enqueued', async () => {
    await setAgentOffline();
    const jobId = await seedJob();

    const res = await drainTestWorkspace();

    expect(res.enqueued).toBe(0);
    const after = await readJob(jobId);
    // Still 'scheduled': a closed laptop must never fail or lose the job.
    expect(after?.status).toBe('scheduled');
    expect(new Date(after!.scheduled_for as any).getTime()).toBeGreaterThan(Date.now());
  });

  t('G2: with the laptop on, the same job is enqueued as normal', async () => {
    await setAgentOnline();
    const jobId = await seedJob();

    const res = await drainTestWorkspace();

    expect(res.enqueued).toBe(1);
    expect((await readJob(jobId))?.status).toBe('queued');
  });

  t('G3: the deferral carries the marker wake-on-reconnect searches for', async () => {
    await setAgentOffline();
    const jobId = await seedJob();

    await drainTestWorkspace();

    // AgentController wakes jobs on exactly this triple: 'scheduled' +
    // 'agent_unavailable' + a future scheduled_for.
    const after = await readJob(jobId);
    expect(after?.status).toBe('scheduled');
    expect(after?.last_error).toBe('agent_unavailable');
    expect(new Date(after!.scheduled_for as any).getTime()).toBeGreaterThan(Date.now());
  });

  t('G4: an email job is not gated by the LinkedIn agent heartbeat', async () => {
    await setAgentOffline();
    const jobId = await seedJob('email');

    const res = await drainTestWorkspace();

    // Email sends run server-side, so an offline agent must not hold them.
    expect(res.enqueued).toBe(1);
    expect((await readJob(jobId))?.status).toBe('queued');
  });
});
