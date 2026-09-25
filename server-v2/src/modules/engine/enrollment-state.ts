import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '@/db';

/**
 * The only writes the send pipeline makes to an enrollment, each guarded by the
 * state the enrollment is in NOW.
 *
 * 🔴 The worker used to write enrollments unconditionally. A lead who replied
 * was set to 'replied', and then the follow-up already in the queue went out and
 * `advanceEnrollment` set the enrollment back to 'active' — so the sequence
 * carried on after the prospect answered. Pacing / agent-offline defers did the
 * same to a PAUSED lead (→ 'waiting'), which the campaign runner then drove
 * again. A human decision (pause) or the prospect's (reply) must win over a
 * background write, so every write here names the states it may replace.
 *
 * All helpers take the caller's workspace-scoped transaction.
 */

type Db = Kysely<DatabaseSchema>;

/** States the pipeline itself moves between; anything else was decided elsewhere. */
const LIVE = ['active', 'waiting'] as const;

/**
 * After a successful send (or a skip that counts as done): point the enrollment
 * at the step after `stepId`, or finish it.
 *
 * 'failed' may also be moved on: a transient failure marks the enrollment failed
 * while BullMQ retries the job, and a retry that then succeeds must resume the
 * sequence rather than leave it failed.
 */
export async function advanceEnrollment(
  db: Db,
  workspaceId: string,
  enrollmentId: string | null,
  stepId: string | null,
): Promise<void> {
  if (!enrollmentId || !stepId) return;
  const step = await db
    .selectFrom('campaign_steps')
    .select('next_step_id')
    .where('id', '=', stepId)
    .executeTakeFirst();
  const nextStepId = step?.next_step_id || null;
  const now = new Date().toISOString();
  await db
    .updateTable('enrollments')
    .set({
      current_step_id: nextStepId,
      status: nextStepId ? 'active' : 'finished',
      // Reset the step-entry clock so the next step's delay window / condition
      // timeout is measured from now, and clear the wait marker so the campaign
      // runner picks it up on the next tick.
      step_entered_at: now,
      next_run_at: nextStepId ? now : null,
      finished_at: nextStepId ? null : now,
    })
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', enrollmentId)
    .where('status', 'in', [...LIVE, 'failed'])
    .execute();
}

/** The job was deferred — the enrollment waits for it until `runAt`. */
export async function deferEnrollment(
  db: Db,
  workspaceId: string,
  enrollmentId: string | null,
  runAt: string,
): Promise<void> {
  if (!enrollmentId) return;
  await db
    .updateTable('enrollments')
    .set({ status: 'waiting', next_run_at: runAt })
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', enrollmentId)
    .where('status', 'in', [...LIVE])
    .execute();
}

/** The job failed or its account halted: mark the enrollment, if still live. */
export async function setLiveEnrollmentStatus(
  db: Db,
  workspaceId: string,
  enrollmentId: string | null,
  status: 'failed' | 'paused',
): Promise<void> {
  if (!enrollmentId) return;
  await db
    .updateTable('enrollments')
    .set({ status })
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', enrollmentId)
    .where('status', 'in', [...LIVE])
    .execute();
}

/**
 * The lead answered: end every running sequence for them and withdraw whatever
 * outreach to them is still waiting to go out.
 *
 * Setting the enrollment to 'replied' alone was not enough — the executor
 * materialises each step's job as soon as the previous one sends, so the next
 * follow-up was usually already 'scheduled' days ahead and still went out. A
 * 'running' job is mid-action on the agent and cannot be recalled.
 *
 * Returns how many pending jobs were withdrawn.
 */
export async function stopSequencesOnReply(db: Db, workspaceId: string, leadId: string): Promise<number> {
  await db
    .updateTable('enrollments')
    .set({ status: 'replied', next_run_at: null })
    .where('workspace_id', '=', workspaceId)
    .where('lead_id', '=', leadId)
    .where('status', 'in', [...LIVE, 'paused'])
    .execute();
  const res = await db
    .updateTable('jobs')
    .set({ status: 'canceled', last_error: 'lead_replied' })
    .where('workspace_id', '=', workspaceId)
    .where('lead_id', '=', leadId)
    .where('status', 'in', ['scheduled', 'queued'])
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}
