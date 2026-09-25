import { Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '@/db';
import { withWorkspace } from '@/db/rls';
import { ConditionEvaluator } from './condition-evaluator';
import { spin } from './spintax';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';

let redisClient: Redis | null = null;
let linkedinQueue: Queue | null = null;
let emailQueue: Queue | null = null;

function getQueue(name: string): Queue {
  if (name === 'linkedin-actions') {
    if (linkedinQueue) return linkedinQueue;
    const env = getEnv();
    if (!redisClient) redisClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    linkedinQueue = new Queue('linkedin-actions', { connection: redisClient as any });
    return linkedinQueue;
  } else {
    if (emailQueue) return emailQueue;
    const env = getEnv();
    if (!redisClient) redisClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    emailQueue = new Queue('email-send', { connection: redisClient as any });
    return emailQueue;
  }
}

/** Actions that actually reach out (get a durable job + a browser/email send). */
const OUTBOUND_ACTIONS = new Set([
  'connect_request',
  'linkedin_message',
  'inmail',
  'visit_profile',
  'follow',
  'like_post',
  'endorse_skill',
  'send_email',
]);

const CHANNEL_OF: Record<string, 'linkedin' | 'email'> = {
  connect_request: 'linkedin',
  linkedin_message: 'linkedin',
  inmail: 'linkedin',
  visit_profile: 'linkedin',
  follow: 'linkedin',
  like_post: 'linkedin',
  endorse_skill: 'linkedin',
  send_email: 'email',
};

/** Job statuses that mean "this step's job is still on its way". */
const IN_FLIGHT = new Set(['scheduled', 'queued', 'running']);

/**
 * How long to leave an enrollment alone while its job is in flight. Only the
 * re-check cadence: the worker pulls the enrollment forward the moment the job
 * finishes (advanceEnrollment) or is deferred (it writes next_run_at itself).
 * Without it, an enrollment whose job the scheduler keeps deferring (agent
 * offline, account paused) is re-visited on EVERY runner tick, and a few hundred
 * of those crowd newer enrollments out of the runner's per-tick batch.
 */
const IN_FLIGHT_RECHECK_MS = 5 * 60_000;

/**
 * Upper bound on steps walked in one call. Conditions, waits and skipped steps
 * advance without creating a job, so a chain of them is walked in a loop; the
 * bound turns a malformed (cyclic) graph into a stopped enrollment instead of a
 * hot loop.
 */
const MAX_HOPS = 25;

/**
 * What a CANCELED job for the current step means for the enrollment.
 *
 * 🔴 Previously any existing job — canceled included — made executeStep return
 * without doing anything. Pausing a lead cancels its pending job, so resuming it
 * left the enrollment `active` on a step whose only job was canceled: it was
 * re-visited every tick and never moved again. The cancel REASON decides:
 *   - the step is already satisfied  → advance to the next step
 *   - the lead must not be contacted → end the enrollment
 *   - the job was only paused away   → create a fresh job (the resume path)
 */
function onCanceledJob(lastError: string | null): 'advance' | 'stop' | 'replied' | 'recreate' {
  const reason = lastError || '';
  // The scheduler found an invite to this person already sent — the step's goal
  // is met, exactly like the worker's pending/already_connected skip.
  if (reason === 'duplicate_invite') return 'advance';
  if (reason === 'lead_replied') return 'replied';
  if (
    reason.startsWith('suppressed:') || // blacklisted / unqualified lead
    reason === 'canceled_by_user' || // the user stopped this send by hand
    reason === 'enrollment_removed' ||
    reason === 'campaign_deleted'
  ) {
    return 'stop';
  }
  // enrollment_paused, campaign_paused, campaign_inactive, enrollment_inactive,
  // sequence_edited, … — cancelled only because the sequence was on hold.
  return 'recreate';
}

type Enqueue = {
  jobId: string;
  channel: 'linkedin' | 'email';
  leadId: string;
  payload: Record<string, unknown>;
};

@Injectable()
export class GraphExecutor {
  private readonly logger = new Logger(GraphExecutor.name);

  constructor(private readonly conditionEvaluator: ConditionEvaluator) {}

  /**
   * Evaluate the enrollment's current step and schedule the next action.
   *
   * Safe to call repeatedly (the campaign runner does, on every tick, for any
   * enrollment that is active or whose wait window has elapsed):
   *   - CONDITION steps honour the step's delay window (`delay_hours` after the
   *     lead entered the step) before evaluating, then branch to on_true/on_false.
   *   - WAIT / internal steps simply advance once their delay has elapsed.
   *   - OUTBOUND steps materialise exactly one live job per enrollment+step, then
   *     park the enrollment as `waiting`; the worker's post-send
   *     `advanceEnrollment` flips it back to `active` for the next step.
   *
   * Every read and write runs in ONE `withWorkspace` transaction. It used to use
   * raw getDb(), which only worked because the production role bypassed RLS —
   * connected as a role subject to RLS, `enrollments`/`jobs`/`leads` read as empty
   * and every campaign silently stopped. A due-now job is handed to BullMQ only
   * after that transaction commits, so the worker can always see its row.
   */
  async executeStep(workspaceId: string, enrollmentId: string): Promise<void> {
    const enqueue = await withWorkspace(workspaceId, (db) =>
      this.advance(db, workspaceId, enrollmentId),
    );
    if (!enqueue) return;

    const q = enqueue.channel === 'linkedin' ? getQueue('linkedin-actions') : getQueue('email-send');
    try {
      await q.add(
        enqueue.channel === 'linkedin' ? 'linkedin-connect' : 'email-send',
        { jobId: enqueue.jobId, workspaceId, leadId: enqueue.leadId, payload: enqueue.payload },
        {
          jobId: enqueue.jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (err: any) {
      // Redis unreachable — hand the row back to the scheduler rather than
      // leaving it `queued`, a status nothing ever re-drives.
      this.logger.warn({ jobId: enqueue.jobId, err: err.message }, 'Enqueue failed — reverted to scheduled');
      await withWorkspace(workspaceId, (db) =>
        db
          .updateTable('jobs')
          .set({ status: 'scheduled' })
          .where('workspace_id', '=', workspaceId)
          .where('id', '=', enqueue.jobId)
          .where('status', '=', 'queued')
          .execute(),
      );
    }
  }

  /** Walk the enrollment forward inside the caller's transaction. */
  private async advance(
    db: Kysely<DatabaseSchema>,
    workspaceId: string,
    enrollmentId: string,
  ): Promise<Enqueue | null> {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const enrollment = await db
        .selectFrom('enrollments')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', enrollmentId)
        .executeTakeFirst();

      if (!enrollment) return null;
      // Only active/waiting enrollments advance; paused/finished/failed are terminal here.
      if (enrollment.status !== 'active' && enrollment.status !== 'waiting') return null;

      const currentStepId = enrollment.current_step_id;
      if (!currentStepId) {
        await this.finish(db, enrollmentId);
        return null;
      }

      const step = await db
        .selectFrom('campaign_steps')
        .selectAll()
        .where('id', '=', currentStepId)
        .executeTakeFirst();

      if (!step) {
        // Dangling step reference — end the sequence rather than loop forever.
        await this.finish(db, enrollmentId);
        return null;
      }

      const now = Date.now();
      const enteredAt = new Date(
        (enrollment.step_entered_at as any) || (enrollment.enrolled_at as any) || now,
      ).getTime();
      const dueAt = enteredAt + (Number(step.delay_hours) || 0) * 3600_000;

      // ---- CONDITION step: wait out the window, then branch. -----------------
      if (step.kind === 'condition') {
        if (now < dueAt) {
          await this.park(db, enrollmentId, new Date(dueAt).toISOString());
          return null;
        }
        const met = await this.conditionEvaluator.evaluate(
          workspaceId,
          enrollment.lead_id,
          step.condition!,
          step.params,
          db,
        );
        const nextStepId = (met ? step.on_true_step_id : step.on_false_step_id) || null;
        if (!(await this.moveTo(db, enrollmentId, nextStepId))) return null;
        continue; // evaluate the branch target (may be another condition or an action)
      }

      // ---- Non-outbound action (wait / enrich / tag / webhook): advance. -----
      if (!OUTBOUND_ACTIONS.has(step.action || '')) {
        if (now < dueAt) {
          await this.park(db, enrollmentId, new Date(dueAt).toISOString());
          return null;
        }
        if (!(await this.moveTo(db, enrollmentId, step.next_step_id || null))) return null;
        continue;
      }

      // ---- OUTBOUND action: at most one live job per enrollment+step. --------
      const existing = await db
        .selectFrom('jobs')
        .select(['id', 'status', 'last_error', 'scheduled_for'])
        .where('workspace_id', '=', workspaceId)
        .where('enrollment_id', '=', enrollmentId)
        .where('step_id', '=', step.id)
        .orderBy('created_at', 'desc')
        .execute();
      const latest = existing[0];

      if (latest) {
        if (IN_FLIGHT.has(latest.status as string)) {
          // Still on its way — look again later (see IN_FLIGHT_RECHECK_MS).
          const dueMs = new Date(latest.scheduled_for as any).getTime() || 0;
          await this.park(db, enrollmentId, new Date(Math.max(dueMs, now + IN_FLIGHT_RECHECK_MS)).toISOString());
          return null;
        }
        if (latest.status === 'sent') {
          // The step is done but the enrollment never moved on (post-send
          // bookkeeping lost, or it landed while the lead was paused). Move on.
          if (!(await this.moveTo(db, enrollmentId, step.next_step_id || null))) return null;
          continue;
        }
        if (latest.status === 'failed') {
          // A terminal-failed job means the step can't complete — stop the lead so
          // it doesn't get stuck retrying forever.
          await db
            .updateTable('enrollments')
            .set({ status: 'failed', finished_at: new Date().toISOString(), next_run_at: null })
            .where('id', '=', enrollmentId)
            .execute();
          return null;
        }
        // canceled
        const verdict = onCanceledJob(latest.last_error as string | null);
        if (verdict === 'advance') {
          if (!(await this.moveTo(db, enrollmentId, step.next_step_id || null))) return null;
          continue;
        }
        if (verdict === 'stop' || verdict === 'replied') {
          await db
            .updateTable('enrollments')
            .set({
              status: verdict === 'replied' ? 'replied' : 'stopped',
              finished_at: new Date().toISOString(),
              next_run_at: null,
            })
            .where('id', '=', enrollmentId)
            .execute();
          return null;
        }
        // 'recreate' falls through and materialises a fresh job below.
      }

      return this.materialise(db, workspaceId, enrollment, step, dueAt, existing.length);
    }

    this.logger.warn({ enrollmentId }, `Walked ${MAX_HOPS} steps without reaching an action — stopping the enrollment`);
    await db
      .updateTable('enrollments')
      .set({ status: 'stopped', finished_at: new Date().toISOString(), next_run_at: null })
      .where('id', '=', enrollmentId)
      .execute();
    return null;
  }

  /** Create the durable job for an outbound step and park the enrollment on it. */
  private async materialise(
    db: Kysely<DatabaseSchema>,
    workspaceId: string,
    enrollment: any,
    step: any,
    dueAt: number,
    priorJobs: number,
  ): Promise<Enqueue | null> {
    const now = Date.now();
    const lead = await db
      .selectFrom('leads')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', enrollment.lead_id)
      .executeTakeFirstOrThrow();

    let templateBody = '';
    let subject = '';
    if (step.template_id) {
      const tpl = await db
        .selectFrom('templates')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', step.template_id)
        .executeTakeFirst();
      if (tpl) {
        templateBody = tpl.body;
        subject = tpl.subject || '';
      }
    }
    // Inline message body (builder message/email steps store it on the step params).
    const params = (typeof step.params === 'string' ? JSON.parse(step.params) : step.params) || {};
    if (!templateBody && params.body) templateBody = String(params.body);
    if (!subject && params.subject) subject = String(params.subject);

    const channel = CHANNEL_OF[step.action!] || 'linkedin';
    const renderedBody = this.renderTemplate(templateBody, lead);
    const renderedSubject = this.renderTemplate(subject, lead);

    const jobId = crypto.randomUUID();
    const scheduledFor = new Date(Math.max(now, dueAt));

    const payload = {
      name: lead.full_name,
      target: channel === 'linkedin' ? lead.linkedin_url || '' : lead.email || '',
      company: lead.company,
      role: lead.title,
      message: renderedBody,
      subject: renderedSubject,
    };

    const campaign = await db
      .selectFrom('campaigns')
      .select(['linkedin_account_id', 'email_account_id'])
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', enrollment.campaign_id)
      .executeTakeFirst();

    const dueNow = scheduledFor.getTime() <= now;

    await db
      .insertInto('jobs')
      .values({
        id: jobId,
        workspace_id: workspaceId,
        campaign_id: enrollment.campaign_id,
        enrollment_id: enrollment.id,
        step_id: step.id,
        lead_id: lead.id,
        linkedin_account_id: campaign?.linkedin_account_id || null,
        email_account_id: campaign?.email_account_id || null,
        kind: channel,
        action: step.action! as any,
        payload: JSON.stringify(payload),
        // Due now → hand straight to BullMQ (status queued); future → let the
        // scheduler pick it up when scheduled_for arrives.
        status: dueNow ? 'queued' : 'scheduled',
        scheduled_for: scheduledFor.toISOString(),
        // idempotency_key is UNIQUE. A step re-materialised after a pause gets
        // its own key; the first job keeps the original shape.
        idempotency_key:
          priorJobs === 0
            ? `enrollment:${enrollment.id}:step:${step.id}`
            : `enrollment:${enrollment.id}:step:${step.id}:r${priorJobs}`,
      })
      .execute();

    // Park the enrollment until the job completes (worker advances it) or the
    // scheduled_for arrives (scheduler dispatches, worker advances).
    await this.park(db, enrollment.id, scheduledFor.toISOString());

    return dueNow ? { jobId, channel, leadId: lead.id, payload } : null;
  }

  /**
   * Point the enrollment at a new step, resetting the step-entry clock. Returns
   * false when there is no next step (the enrollment is finished instead).
   */
  private async moveTo(
    db: Kysely<DatabaseSchema>,
    enrollmentId: string,
    nextStepId: string | null,
  ): Promise<boolean> {
    if (!nextStepId) {
      await this.finish(db, enrollmentId);
      return false;
    }
    await db
      .updateTable('enrollments')
      .set({
        current_step_id: nextStepId,
        status: 'active',
        step_entered_at: new Date().toISOString(),
        next_run_at: new Date().toISOString(),
      })
      .where('id', '=', enrollmentId)
      .execute();
    return true;
  }

  /** Park an enrollment as waiting until `runAt` (a job or a wait window). */
  private async park(db: Kysely<DatabaseSchema>, enrollmentId: string, runAt: string): Promise<void> {
    await db
      .updateTable('enrollments')
      .set({ status: 'waiting', next_run_at: runAt })
      .where('id', '=', enrollmentId)
      .execute();
  }

  private async finish(db: Kysely<DatabaseSchema>, enrollmentId: string): Promise<void> {
    await db
      .updateTable('enrollments')
      .set({ status: 'finished', finished_at: new Date().toISOString(), next_run_at: null })
      .where('id', '=', enrollmentId)
      .execute();
  }

  private renderTemplate(tpl: string, lead: any): string {
    const map: Record<string, string> = {
      firstName: lead.first_name,
      lastName: String(lead.full_name || '').split(' ').slice(1).join(' '),
      fullName: lead.full_name,
      company: lead.company,
      title: lead.title,
      location: lead.location,
    };
    // Variables first, then spintax ({Hi|Hey|Hello}) — see spintax.ts.
    const filled = String(tpl || '').replace(
      /\{\{(\w+)(?:\|([^}]*))?\}\}/g,
      (_, key, fb) => map[key] || fb || `{{${key}}}`,
    );
    return spin(filled);
  }
}
