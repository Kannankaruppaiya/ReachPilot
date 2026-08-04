import { Injectable } from '@nestjs/common';
import { getDb } from '@/db';
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

@Injectable()
export class GraphExecutor {
  constructor(private readonly conditionEvaluator: ConditionEvaluator) {}

  /**
   * Evaluate the enrollment's current step and schedule the next action.
   *
   * Safe to call repeatedly (the campaign runner does, on every tick, for any
   * enrollment that is active or whose wait window has elapsed):
   *   - CONDITION steps honour the step's delay window (`delay_hours` after the
   *     lead entered the step) before evaluating, then branch to on_true/on_false.
   *   - WAIT / internal steps simply advance once their delay has elapsed.
   *   - OUTBOUND steps materialise exactly one durable job (idempotency-guarded on
   *     enrollment+step), then park the enrollment as `waiting`; the worker's
   *     post-send `advanceEnrollment` flips it back to `active` for the next step.
   */
  async executeStep(workspaceId: string, enrollmentId: string): Promise<void> {
    const db = getDb();
    const enrollment = await db
      .selectFrom('enrollments')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', enrollmentId)
      .executeTakeFirst();

    if (!enrollment) return;
    // Only active/waiting enrollments advance; paused/finished/failed are terminal here.
    if (enrollment.status !== 'active' && enrollment.status !== 'waiting') return;

    const currentStepId = enrollment.current_step_id;
    if (!currentStepId) {
      await this.finish(enrollmentId);
      return;
    }

    const step = await db
      .selectFrom('campaign_steps')
      .selectAll()
      .where('id', '=', currentStepId)
      .executeTakeFirst();

    if (!step) {
      // Dangling step reference — end the sequence rather than loop forever.
      await this.finish(enrollmentId);
      return;
    }

    const now = Date.now();
    const enteredAt = new Date(
      (enrollment.step_entered_at as any) || (enrollment.enrolled_at as any) || now,
    ).getTime();
    const dueAt = enteredAt + (Number(step.delay_hours) || 0) * 3600_000;

    // ---- CONDITION step: wait out the window, then branch. -------------------
    if (step.kind === 'condition') {
      if (now < dueAt) {
        await this.park(enrollmentId, new Date(dueAt).toISOString());
        return;
      }
      const met = await this.conditionEvaluator.evaluate(
        workspaceId,
        enrollment.lead_id,
        step.condition!,
        step.params,
      );
      const nextStepId = (met ? step.on_true_step_id : step.on_false_step_id) || null;
      await this.moveTo(enrollmentId, nextStepId);
      // Immediately evaluate the branch target (may be another condition or an action).
      return this.executeStep(workspaceId, enrollmentId);
    }

    // ---- Non-outbound action (wait / enrich / tag / webhook): advance. -------
    if (!OUTBOUND_ACTIONS.has(step.action || '')) {
      if (now < dueAt) {
        await this.park(enrollmentId, new Date(dueAt).toISOString());
        return;
      }
      await this.moveTo(enrollmentId, step.next_step_id || null);
      return this.executeStep(workspaceId, enrollmentId);
    }

    // ---- OUTBOUND action: materialise one job, then wait for it. --------------
    // Idempotency: never create a second job for the same enrollment+step (the
    // runner may re-visit a `waiting` enrollment whose job is still in flight).
    const existing = await db
      .selectFrom('jobs')
      .select(['id', 'status'])
      .where('enrollment_id', '=', enrollmentId)
      .where('step_id', '=', step.id)
      .executeTakeFirst();
    if (existing) {
      // A terminal-failed job means the step can't complete — stop the lead so it
      // doesn't get stuck retrying forever; otherwise the job is still pending.
      if (existing.status === 'failed') {
        await db
          .updateTable('enrollments')
          .set({ status: 'failed', finished_at: new Date().toISOString() })
          .where('id', '=', enrollmentId)
          .execute();
      }
      return;
    }

    const lead = await db
      .selectFrom('leads')
      .selectAll()
      .where('id', '=', enrollment.lead_id)
      .executeTakeFirstOrThrow();

    let templateBody = '';
    let subject = '';
    if (step.template_id) {
      const tpl = await db
        .selectFrom('templates')
        .selectAll()
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
      .where('id', '=', enrollment.campaign_id)
      .executeTakeFirst();

    const dueNow = scheduledFor.getTime() <= now;

    await db
      .insertInto('jobs')
      .values({
        id: jobId,
        workspace_id: workspaceId,
        campaign_id: enrollment.campaign_id,
        enrollment_id: enrollmentId,
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
        idempotency_key: `enrollment:${enrollmentId}:step:${step.id}`,
      })
      .execute();

    if (dueNow) {
      const q = channel === 'linkedin' ? getQueue('linkedin-actions') : getQueue('email-send');
      await q.add(
        channel === 'linkedin' ? 'linkedin-connect' : 'email-send',
        { jobId, workspaceId, leadId: lead.id, payload },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }

    // Park the enrollment until the job completes (worker advances it) or the
    // scheduled_for arrives (scheduler dispatches, worker advances).
    await this.park(enrollmentId, scheduledFor.toISOString());
  }

  /** Point the enrollment at a new step, resetting the step-entry clock. */
  private async moveTo(enrollmentId: string, nextStepId: string | null): Promise<void> {
    const db = getDb();
    if (!nextStepId) {
      await this.finish(enrollmentId);
      return;
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
  }

  /** Park an enrollment as waiting until `runAt` (a job or a wait window). */
  private async park(enrollmentId: string, runAt: string): Promise<void> {
    await getDb()
      .updateTable('enrollments')
      .set({ status: 'waiting', next_run_at: runAt })
      .where('id', '=', enrollmentId)
      .execute();
  }

  private async finish(enrollmentId: string): Promise<void> {
    await getDb()
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
