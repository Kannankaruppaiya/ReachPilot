/**
 * What the campaign executor does when the current step ALREADY has a job.
 *
 * It used to return as soon as any job existed for the enrollment+step. Pausing
 * a lead cancels its pending job, so after resume the enrollment sat `active` on
 * a step whose only job was canceled — re-visited on every runner tick, never
 * moving again. Measured before the fix: pause → resume → 3 runner visits left
 * one canceled job and no new one.
 *
 * REQUIREMENTS: local Postgres. SKIPS otherwise. Calls executeStep for the test
 * workspace only; every job is scheduled in the future, so nothing is enqueued.
 */
import { randomUUID } from 'crypto';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { CampaignsService } from '@/modules/campaigns/campaigns.service';
import { GraphExecutor } from '@/modules/engine/graph-executor';
import { ConditionEvaluator } from '@/modules/engine/condition-evaluator';
import { assertLocalServices } from './local-only';

const WS = '00000000-0000-0000-0000-0000000000d1';

let reachable = false;
let skipReason = '';
const campaigns = new CampaignsService();
const executor = new GraphExecutor(new ConditionEvaluator());

beforeAll(async () => {
  try {
    assertLocalServices(getEnv());
    await getDb().deleteFrom('workspaces').where('id', '=', WS).execute();
    await getDb().insertInto('workspaces').values({ id: WS, name: 'enrollment-resume' }).execute();
    reachable = true;
  } catch (e: any) {
    skipReason = e.message;
  }
}, 60_000);

afterAll(async () => {
  if (reachable) await getDb().deleteFrom('workspaces').where('id', '=', WS).execute();
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

/** invite (in 1 day) → message (1 day later). Returns the enrollment + step ids. */
async function enrolledLead() {
  const leadId = randomUUID();
  await withWorkspace(WS, (db) =>
    db
      .insertInto('leads')
      .values({
        id: leadId,
        workspace_id: WS,
        full_name: 'Resume Prospect',
        first_name: 'Resume',
        linkedin_url: `https://www.linkedin.com/in/resume-${leadId.slice(0, 8)}`,
        linkedin_slug: `resume-${leadId.slice(0, 8)}`,
        status: 'new',
        source: 'test',
      })
      .execute(),
  );
  const camp = await campaigns.create(WS, {
    name: `resume ${leadId.slice(0, 6)}`,
    steps: [
      { kind: 'wait', days: 1 },
      { kind: 'invite' },
      { kind: 'wait', days: 1 },
      { kind: 'message', body: 'thanks for connecting' },
    ],
    leadIds: [leadId],
    launch: true,
  });
  const detail = await campaigns.get(WS, camp.id);
  const enrollmentId = detail.enrollments[0].enrollmentId as string;
  const [inviteStep, messageStep] = detail.steps.map((s: any) => s.id as string);
  return { campaignId: camp.id as string, enrollmentId, inviteStep, messageStep };
}

const jobsOf = (enrollmentId: string) =>
  withWorkspace(WS, (db) =>
    db
      .selectFrom('jobs')
      .select(['id', 'status', 'step_id', 'last_error', 'idempotency_key'])
      .where('enrollment_id', '=', enrollmentId)
      .orderBy('created_at', 'asc')
      .execute(),
  );

const enrollment = (id: string) =>
  withWorkspace(WS, (db) =>
    db.selectFrom('enrollments').select(['status', 'current_step_id', 'next_run_at']).where('id', '=', id).executeTakeFirstOrThrow(),
  );

const setJob = (id: string, patch: Record<string, unknown>) =>
  withWorkspace(WS, (db) => db.updateTable('jobs').set(patch).where('id', '=', id).execute());

describe('executeStep with an existing job on the current step', () => {
  t('pause → resume creates a fresh job for the step instead of stalling', async () => {
    const e = await enrolledLead();
    await executor.executeStep(WS, e.enrollmentId);
    expect((await jobsOf(e.enrollmentId)).map((j) => j.status)).toEqual(['scheduled']);

    await campaigns.setEnrollmentStatus(WS, e.campaignId, e.enrollmentId, 'pause');
    await campaigns.setEnrollmentStatus(WS, e.campaignId, e.enrollmentId, 'resume');
    await executor.executeStep(WS, e.enrollmentId);

    const jobs = await jobsOf(e.enrollmentId);
    expect(jobs.map((j) => j.status)).toEqual(['canceled', 'scheduled']);
    expect(jobs[1].step_id).toBe(e.inviteStep);
    // idempotency_key is UNIQUE — the re-created job must not collide with the first.
    expect(jobs[1].idempotency_key).not.toBe(jobs[0].idempotency_key);
    expect((await enrollment(e.enrollmentId)).status).toBe('waiting');

    // …and re-visiting while that job is in flight never makes a third.
    await executor.executeStep(WS, e.enrollmentId);
    expect(await jobsOf(e.enrollmentId)).toHaveLength(2);
  });

  t('an invite canceled as a duplicate counts as done and moves to the next step', async () => {
    const e = await enrolledLead();
    await executor.executeStep(WS, e.enrollmentId);
    const [invite] = await jobsOf(e.enrollmentId);
    await setJob(invite.id, { status: 'canceled', last_error: 'duplicate_invite' });

    await executor.executeStep(WS, e.enrollmentId);

    const jobs = await jobsOf(e.enrollmentId);
    expect(jobs.map((j) => [j.step_id, j.status])).toEqual([
      [e.inviteStep, 'canceled'],
      [e.messageStep, 'scheduled'],
    ]);
    expect((await enrollment(e.enrollmentId)).current_step_id).toBe(e.messageStep);
  });

  t('a job canceled because the lead is suppressed ends the enrollment', async () => {
    const e = await enrolledLead();
    await executor.executeStep(WS, e.enrollmentId);
    const [invite] = await jobsOf(e.enrollmentId);
    await setJob(invite.id, { status: 'canceled', last_error: 'suppressed:blacklisted' });

    await executor.executeStep(WS, e.enrollmentId);

    expect(await jobsOf(e.enrollmentId)).toHaveLength(1);
    expect((await enrollment(e.enrollmentId)).status).toBe('stopped');
  });

  t('a sent job whose enrollment never moved on is advanced past', async () => {
    const e = await enrolledLead();
    await executor.executeStep(WS, e.enrollmentId);
    const [invite] = await jobsOf(e.enrollmentId);
    // The send landed but the worker's post-send bookkeeping did not.
    await setJob(invite.id, { status: 'sent', sent_at: new Date().toISOString() });

    await executor.executeStep(WS, e.enrollmentId);

    const jobs = await jobsOf(e.enrollmentId);
    expect(jobs.map((j) => j.step_id)).toEqual([e.inviteStep, e.messageStep]);
    expect((await enrollment(e.enrollmentId)).current_step_id).toBe(e.messageStep);
  });

  t('a job still in flight parks the enrollment instead of re-visiting it every tick', async () => {
    const e = await enrolledLead();
    await executor.executeStep(WS, e.enrollmentId);
    const [invite] = await jobsOf(e.enrollmentId);
    // Due already (the scheduler just has not picked it up yet).
    await setJob(invite.id, { scheduled_for: new Date(Date.now() - 60_000).toISOString() });
    await withWorkspace(WS, (db) =>
      db.updateTable('enrollments').set({ next_run_at: new Date(Date.now() - 60_000).toISOString() }).where('id', '=', e.enrollmentId).execute(),
    );

    await executor.executeStep(WS, e.enrollmentId);

    const next = new Date((await enrollment(e.enrollmentId)).next_run_at as any).getTime();
    expect(next).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(await jobsOf(e.enrollmentId)).toHaveLength(1);
  });
});
