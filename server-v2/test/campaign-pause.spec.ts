/**
 * Pausing a campaign must cancel what it already scheduled; the scheduler also
 * holds jobs of paused campaigns. Skips without local Postgres. Uses the private
 * drainWorkspace, never tick(); every drained job ends canceled or deferred.
 */
import { randomUUID } from 'crypto';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { CampaignsService } from '@/modules/campaigns/campaigns.service';
import { GraphExecutor } from '@/modules/engine/graph-executor';
import { ConditionEvaluator } from '@/modules/engine/condition-evaluator';
import { SchedulerService, sequenceHold } from '@/modules/engine/scheduler.service';
import { assertLocalServices } from './local-only';

const WS = '00000000-0000-0000-0000-0000000000c1';
const ACCT = '00000000-0000-0000-0000-0000000000c2';

let reachable = false;
let skipReason = '';
const campaigns = new CampaignsService();
const executor = new GraphExecutor(new ConditionEvaluator());
const scheduler = new SchedulerService();

beforeAll(async () => {
  try {
    assertLocalServices(getEnv());
    await getDb().deleteFrom('workspaces').where('id', '=', WS).execute();
    await getDb().insertInto('workspaces').values({ id: WS, name: 'campaign-pause' }).execute();
    // A paused account: a job past the sequence gate is deferred, not enqueued.
    await withWorkspace(WS, (db) =>
      db
        .insertInto('linkedin_accounts')
        .values({ id: ACCT, workspace_id: WS, email: 'pause-probe@test.local', country: 'IN', status: 'paused' })
        .execute(),
    );
    reachable = true;
  } catch (e: any) {
    skipReason = e.message;
  }
}, 60_000);

afterAll(async () => {
  if (reachable) await getDb().deleteFrom('workspaces').where('id', '=', WS).execute();
  await (scheduler as any)?.redis?.quit?.().catch(() => undefined);
  await (scheduler as any)?.linkedinQueue?.close?.().catch(() => undefined);
  await getDb().destroy();
}, 60_000);

const t = (name: string, fn: () => Promise<void>) =>
  it(
    name,
    async () => {
      if (!reachable) {
        console.warn(`  ↳ skipped (${skipReason})`);
        return;
      }
      await fn();
    },
    60_000,
  );

/** One lead in a launched "wait 1 day → invite" campaign, its job materialised. */
async function campaignWithJob() {
  const leadId = randomUUID();
  await withWorkspace(WS, (db) =>
    db
      .insertInto('leads')
      .values({
        id: leadId,
        workspace_id: WS,
        full_name: 'Pause Prospect',
        first_name: 'Pause',
        linkedin_url: `https://www.linkedin.com/in/pause-${leadId.slice(0, 8)}`,
        linkedin_slug: `pause-${leadId.slice(0, 8)}`,
        status: 'new',
        source: 'test',
      })
      .execute(),
  );
  const camp = await campaigns.create(WS, {
    name: `pause ${leadId.slice(0, 6)}`,
    steps: [{ kind: 'wait', days: 1 }, { kind: 'invite' }],
    leadIds: [leadId],
    launch: true,
  });
  await withWorkspace(WS, (db) =>
    db.updateTable('campaigns').set({ linkedin_account_id: ACCT }).where('id', '=', camp.id).execute(),
  );
  const enrollmentId = (await campaigns.get(WS, camp.id)).enrollments[0].enrollmentId as string;
  await executor.executeStep(WS, enrollmentId);
  return { campaignId: camp.id as string, enrollmentId };
}

const jobsOf = (campaignId: string) =>
  withWorkspace(WS, (db) =>
    db
      .selectFrom('jobs')
      .select(['id', 'status', 'last_error'])
      .where('campaign_id', '=', campaignId)
      .orderBy('created_at', 'asc')
      .execute(),
  );

/** Make every job of the campaign due now, so the scheduler considers it. */
const makeDue = (campaignId: string) =>
  withWorkspace(WS, (db) =>
    db
      .updateTable('jobs')
      .set({ scheduled_for: new Date(Date.now() - 60_000).toISOString() })
      .where('campaign_id', '=', campaignId)
      .where('status', '=', 'scheduled')
      .execute(),
  );

const drain = () => (scheduler as any).drainWorkspace(WS);

describe('pausing a campaign', () => {
  t('cancels the jobs it already scheduled, and resume makes them again', async () => {
    const c = await campaignWithJob();
    expect((await jobsOf(c.campaignId)).map((j) => j.status)).toEqual(['scheduled']);

    await campaigns.update(WS, c.campaignId, { status: 'Paused' });
    expect((await jobsOf(c.campaignId)).map((j) => [j.status, j.last_error])).toEqual([
      ['canceled', 'campaign_paused'],
    ]);

    await campaigns.update(WS, c.campaignId, { status: 'Active' });
    await executor.executeStep(WS, c.enrollmentId);
    expect((await jobsOf(c.campaignId)).map((j) => j.status)).toEqual(['canceled', 'scheduled']);
  });

  t('the scheduler cancels a job whose campaign is not active', async () => {
    const c = await campaignWithJob();
    await makeDue(c.campaignId);
    // Paused behind the service's back — the job is still 'scheduled'.
    await withWorkspace(WS, (db) =>
      db.updateTable('campaigns').set({ status: 'paused' }).where('id', '=', c.campaignId).execute(),
    );

    const res = await drain();

    expect(res.enqueued).toBe(0);
    expect((await jobsOf(c.campaignId)).map((j) => [j.status, j.last_error])).toEqual([
      ['canceled', 'campaign_paused'],
    ]);
  });

  t('the scheduler cancels a job whose lead already replied', async () => {
    const c = await campaignWithJob();
    await makeDue(c.campaignId);
    await withWorkspace(WS, (db) =>
      db.updateTable('enrollments').set({ status: 'replied' }).where('id', '=', c.enrollmentId).execute(),
    );

    await drain();

    expect((await jobsOf(c.campaignId)).map((j) => [j.status, j.last_error])).toEqual([
      ['canceled', 'lead_replied'],
    ]);
  });

  t('a live campaign job is not held by the sequence gate', async () => {
    const c = await campaignWithJob();
    await makeDue(c.campaignId);

    const res = await drain();

    // It got past the sequence gate and stopped at the (paused) account gate.
    expect(res.enqueued).toBe(0);
    expect((await jobsOf(c.campaignId)).map((j) => [j.status, j.last_error])).toEqual([
      ['scheduled', 'account_paused'],
    ]);
  });
});

describe('sequenceHold', () => {
  it('maps campaign and enrollment state to a cancel reason', () => {
    expect(sequenceHold('active', 'waiting')).toBeNull();
    expect(sequenceHold('active', 'active')).toBeNull();
    expect(sequenceHold(undefined, undefined)).toBeNull(); // Auto Connect / Auto Mail
    expect(sequenceHold('paused', 'waiting')).toBe('campaign_paused');
    expect(sequenceHold('archived', undefined)).toBe('campaign_paused');
    expect(sequenceHold('active', 'replied')).toBe('lead_replied');
    expect(sequenceHold('active', 'paused')).toBe('enrollment_paused');
    expect(sequenceHold('active', 'stopped')).toBe('enrollment_inactive');
  });
});
