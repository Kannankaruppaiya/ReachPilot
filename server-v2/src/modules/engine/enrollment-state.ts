import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '@/db';

// Enrollment writes for the send pipeline. Each names the states it may replace,
// so a user's pause or a lead's reply always wins over a background write.

type Db = Kysely<DatabaseSchema>;

/** States the pipeline itself moves between; anything else was decided elsewhere. */
const LIVE = ['active', 'waiting'] as const;

/**
 * Point the enrollment at the step after `stepId`, or finish it. 'failed' is
 * included so a BullMQ retry that succeeds resumes the sequence.
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
      // Restart the step clock and clear the wait so the runner picks it up next tick.
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
 * The lead replied: end their running sequences and cancel their scheduled or
 * queued jobs (follow-ups are created days ahead). Returns the number cancelled.
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
