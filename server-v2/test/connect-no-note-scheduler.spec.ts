/**
 * LinkedIn connect_request — SCHEDULER gates (group E).
 *
 * The scheduler is what decides whether a scheduled connect_request ever
 * reaches the worker. These tests pin the three gates that can stop one:
 *   - suppression      (blacklisted / unqualified lead → cancel)
 *   - duplicate invite (lead already has a sent connect_request → cancel)
 *   - account health   (checkpoint / paused / disconnected → defer +1h)
 *
 * As with pacing, the note is irrelevant to these gates — a note-less connect
 * is gated identically. That is the point: switching the note off must not let
 * a job slip past a gate that a with-note job would have been stopped by.
 *
 * REQUIREMENTS: reachable Postgres. Suite SKIPS (not fails) if unreachable.
 *
 * SAFETY — read before changing this file:
 *   • We call the PRIVATE drainWorkspace(testWorkspace), never the public
 *     tick(). tick() enumerates EVERY workspace and would enqueue real due jobs
 *     for real accounts — i.e. it could fire genuine LinkedIn invites from a
 *     test run. Never call tick() here.
 *   • Every case asserts a CANCEL or DEFER outcome, all of which `continue`
 *     before the enqueue step, so no BullMQ job is ever produced.
 *   • All rows live under one throwaway workspace, deleted in afterAll.
 */
import { SchedulerService } from '@/modules/engine/scheduler.service';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { randomUUID } from 'crypto';
import { getEnv } from '@/config/env';
import { assertLocalServices } from './local-only';

const WS = '00000000-0000-0000-0000-0000000000e1';
const ACCT = '00000000-0000-0000-0000-0000000000e2';

let scheduler: SchedulerService;
let reachable = false;
let skipReason = '';

/** Drain ONLY the test workspace. See the safety note above — never tick(). */
const drainTestWorkspace = () => (scheduler as any).drainWorkspace(WS);

const pastIso = () => new Date(Date.now() - 60_000).toISOString();

async function seedLead(status: string): Promise<string> {
  const id = randomUUID();
  await withWorkspace(WS, (db) =>
    db
      .insertInto('leads')
      .values({
        id,
        workspace_id: WS,
        full_name: 'Test Prospect',
        first_name: 'Test',
        linkedin_url: `https://www.linkedin.com/in/test-${id.slice(0, 8)}/`,
        status,
      } as any)
      .execute(),
  );
  return id;
}

async function seedConnectJob(leadId: string, status = 'scheduled'): Promise<string> {
  const id = randomUUID();
  await withWorkspace(WS, (db) =>
    db
      .insertInto('jobs')
      .values({
        id,
        workspace_id: WS,
        kind: 'linkedin',
        action: 'connect_request',
        status,
        scheduled_for: pastIso(),
        lead_id: leadId,
        linkedin_account_id: ACCT,
        // noNote: the flow under test — a connection request with no note.
        payload: JSON.stringify({ name: 'Test Prospect', noNote: true }),
      } as any)
      .execute(),
  );
  return id;
}

const readJob = (id: string) =>
  withWorkspace(WS, (db) =>
    db.selectFrom('jobs').select(['status', 'last_error', 'scheduled_for']).where('id', '=', id).executeTakeFirst(),
  );

const setAccountStatus = (status: string) =>
  withWorkspace(WS, (db) =>
    db.updateTable('linkedin_accounts').set({ status } as any).where('id', '=', ACCT).execute(),
  );

beforeAll(async () => {
  try {
    assertLocalServices(getEnv());
    await getDb().selectFrom('workspaces').select('id').limit(1).execute();
    reachable = true;
  } catch (e: any) {
    skipReason = e?.message || String(e);
    console.warn(`\n[connect-no-note-scheduler] SKIPPED — DB unreachable: ${skipReason}\n`);
    return;
  }

  // Seeding is intentionally un-caught: a broken fixture must fail, not skip.
  await getDb()
    .insertInto('workspaces')
    .values({ id: WS, name: 'TEST connect scheduler', goal: 'automated test' } as any)
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await withWorkspace(WS, (db) =>
    db
      .insertInto('linkedin_accounts')
      .values({
        id: ACCT,
        workspace_id: WS,
        email: 'connect-scheduler-test@example.invalid',
        country: 'IN',
        status: 'active',
        warmup_daily_limit: 45,
        warmup_target: 45,
        weekly_invite_cap: 100,
        hours_start: '00:00',
        hours_end: '23:59',
        send_weekends: true,
        timezone: 'UTC',
      } as any)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute(),
  );

  scheduler = new SchedulerService();
}, 60_000);

afterAll(async () => {
  if (reachable) {
    // Children first — jobs reference leads and the account.
    await withWorkspace(WS, (db) => db.deleteFrom('jobs').where('workspace_id', '=', WS).execute()).catch(
      () => undefined,
    );
    await withWorkspace(WS, (db) => db.deleteFrom('leads').where('workspace_id', '=', WS).execute()).catch(
      () => undefined,
    );
    await withWorkspace(WS, (db) =>
      db.deleteFrom('linkedin_accounts').where('id', '=', ACCT).execute(),
    ).catch(() => undefined);
    await getDb().deleteFrom('workspaces').where('id', '=', WS).execute().catch(() => undefined);
  }
  // Release the scheduler's own Redis/BullMQ handles so Jest can exit.
  await (scheduler as any)?.redis?.quit?.().catch(() => undefined);
  await (scheduler as any)?.linkedinQueue?.close?.().catch(() => undefined);
  await (scheduler as any)?.emailQueue?.close?.().catch(() => undefined);
  await getDb().destroy().catch(() => undefined);
}, 60_000);

// Generous timeout: each statement is a round trip to the Supabase pooler, which
// comfortably exceeds Jest's 5s hook default.
beforeEach(async () => {
  if (!reachable) return;
  await withWorkspace(WS, (db) => db.deleteFrom('jobs').where('workspace_id', '=', WS).execute());
  await withWorkspace(WS, (db) => db.deleteFrom('leads').where('workspace_id', '=', WS).execute());
  await setAccountStatus('active');
}, 60_000);

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

describe('Connect request — scheduler gates (no-note connects are gated identically)', () => {
  t('E1: a connect to a BLACKLISTED lead is cancelled, not sent', async () => {
    const leadId = await seedLead('blacklisted');
    const jobId = await seedConnectJob(leadId);

    const res = await drainTestWorkspace();

    const job = await readJob(jobId);
    expect(job?.status).toBe('canceled');
    expect(job?.last_error).toBe('suppressed:blacklisted');
    expect(res.suppressed).toBeGreaterThanOrEqual(1);
    expect(res.enqueued).toBe(0);
  }, 60_000);

  t('E2: a connect to an UNQUALIFIED lead is cancelled', async () => {
    const leadId = await seedLead('unqualified');
    const jobId = await seedConnectJob(leadId);

    await drainTestWorkspace();

    const job = await readJob(jobId);
    expect(job?.status).toBe('canceled');
    expect(job?.last_error).toBe('suppressed:unqualified');
  }, 60_000);

  t('E3: a SECOND connect to a lead already invited is cancelled as a duplicate', async () => {
    const leadId = await seedLead('invited');
    await seedConnectJob(leadId, 'sent'); // the invite that already went out
    const dupId = await seedConnectJob(leadId); // the accidental second one

    await drainTestWorkspace();

    const dup = await readJob(dupId);
    expect(dup?.status).toBe('canceled');
    expect(dup?.last_error).toBe('duplicate_invite');
  }, 60_000);

  t('E4: a CHECKPOINTED account defers the connect ~1h instead of failing it', async () => {
    const leadId = await seedLead('new');
    const jobId = await seedConnectJob(leadId);
    await setAccountStatus('checkpoint');

    const before = Date.now();
    const res = await drainTestWorkspace();

    const job = await readJob(jobId);
    // Still 'scheduled' — held, not burned. A failure here would lose the lead.
    expect(job?.status).toBe('scheduled');
    expect(job?.last_error).toBe('account_checkpoint');
    const deferMin = (new Date(job!.scheduled_for as any).getTime() - before) / 60_000;
    expect(deferMin).toBeGreaterThan(50);
    expect(deferMin).toBeLessThan(70);
    expect(res.deferred).toBeGreaterThanOrEqual(1);
    expect(res.enqueued).toBe(0);
  }, 60_000);

  t('E5: a PAUSED account defers the connect', async () => {
    const leadId = await seedLead('new');
    const jobId = await seedConnectJob(leadId);
    await setAccountStatus('paused');

    await drainTestWorkspace();

    const job = await readJob(jobId);
    expect(job?.status).toBe('scheduled');
    expect(job?.last_error).toBe('account_paused');
  }, 60_000);

  t('E6: a DISCONNECTED account defers the connect', async () => {
    const leadId = await seedLead('new');
    const jobId = await seedConnectJob(leadId);
    await setAccountStatus('disconnected');

    await drainTestWorkspace();

    const job = await readJob(jobId);
    expect(job?.status).toBe('scheduled');
    expect(job?.last_error).toBe('account_disconnected');
  }, 60_000);

  t('E7: suppression is checked BEFORE account health (a blacklisted lead cancels even on a sick account)', async () => {
    const leadId = await seedLead('blacklisted');
    const jobId = await seedConnectJob(leadId);
    await setAccountStatus('checkpoint');

    await drainTestWorkspace();

    const job = await readJob(jobId);
    // Cancelled outright — we must not keep re-deferring a job for a lead we
    // are never allowed to contact.
    expect(job?.status).toBe('canceled');
    expect(job?.last_error).toBe('suppressed:blacklisted');
  }, 60_000);

  t('E8: a job scheduled in the FUTURE is not touched at all', async () => {
    const leadId = await seedLead('new');
    const jobId = randomUUID();
    await withWorkspace(WS, (db) =>
      db
        .insertInto('jobs')
        .values({
          id: jobId,
          workspace_id: WS,
          kind: 'linkedin',
          action: 'connect_request',
          status: 'scheduled',
          scheduled_for: new Date(Date.now() + 3600_000).toISOString(),
          lead_id: leadId,
          linkedin_account_id: ACCT,
          payload: JSON.stringify({ name: 'Test Prospect', noNote: true }),
        } as any)
        .execute(),
    );

    const res = await drainTestWorkspace();

    const job = await readJob(jobId);
    expect(job?.status).toBe('scheduled');
    expect(job?.last_error).toBeFalsy();
    expect(res.enqueued).toBe(0);
  }, 60_000);
});
