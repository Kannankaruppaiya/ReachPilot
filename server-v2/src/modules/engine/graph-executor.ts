import { Injectable } from '@nestjs/common';
import { getDb } from '@/db';
import { ConditionEvaluator } from './condition-evaluator';
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

@Injectable()
export class GraphExecutor {
  constructor(private readonly conditionEvaluator: ConditionEvaluator) {}

  /**
   * Evaluates the current step of an enrollment and schedules the next action.
   */
  async executeStep(workspaceId: string, enrollmentId: string): Promise<void> {
    const db = getDb();
    const enrollment = await db
      .selectFrom('enrollments')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', enrollmentId)
      .executeTakeFirst();

    if (!enrollment || enrollment.status !== 'active') return;

    const currentStepId = enrollment.current_step_id;
    if (!currentStepId) {
      // Completed sequence
      await db
        .updateTable('enrollments')
        .set({ status: 'finished', finished_at: new Date().toISOString() })
        .where('id', '=', enrollmentId)
        .execute();
      return;
    }

    const step = await db
      .selectFrom('campaign_steps')
      .selectAll()
      .where('id', '=', currentStepId)
      .executeTakeFirst();

    if (!step) return;

    if (step.kind === 'condition') {
      const conditionMet = await this.conditionEvaluator.evaluate(
        workspaceId,
        enrollment.lead_id,
        step.condition!,
        step.params,
      );

      const nextStepId = conditionMet ? step.on_true_step_id : step.on_false_step_id;

      await db
        .updateTable('enrollments')
        .set({ current_step_id: nextStepId || null })
        .where('id', '=', enrollmentId)
        .execute();

      // Immediately execute the next step recursively
      return this.executeStep(workspaceId, enrollmentId);
    }

    // Action node
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

    const renderedBody = this.renderTemplate(templateBody, lead);
    const renderedSubject = this.renderTemplate(subject, lead);

    const channelMap: Record<string, 'linkedin' | 'email'> = {
      'connect_request': 'linkedin',
      'linkedin_message': 'linkedin',
      'inmail': 'linkedin',
      'visit_profile': 'linkedin',
      'follow': 'linkedin',
      'like_post': 'linkedin',
      'endorse_skill': 'linkedin',
      'send_email': 'email',
    };

    const channel = channelMap[step.action!] || 'linkedin';

    const jobId = crypto.randomUUID();
    const scheduledTime = new Date();
    scheduledTime.setHours(scheduledTime.getHours() + (step.delay_hours || 0));

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

    // Create outbound Job in scheduled state
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
        status: 'scheduled',
        scheduled_for: scheduledTime.toISOString(),
        idempotency_key: `enrollment:${enrollmentId}:step:${step.id}`,
      })
      .execute();

    // If wait time is 0 (or elapsed), queue into BullMQ
    if ((step.delay_hours || 0) === 0) {
      const q = channel === 'linkedin' ? getQueue('linkedin-actions') : getQueue('email-send');
      await q.add(
        channel === 'linkedin' ? 'linkedin-connect' : 'email-send',
        {
          jobId,
          workspaceId,
          leadId: lead.id,
          payload,
        },
        {
          jobId,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          // A finished BullMQ job left in Redis blocks a later re-add with
          // the same jobId (silent dedupe) — deferred jobs would never rerun.
          removeOnComplete: true,
          removeOnFail: true,
        },
      );

      await db
        .updateTable('jobs')
        .set({ status: 'queued' })
        .where('id', '=', jobId)
        .execute();
    }

    // Set enrollment state to waiting on this action completion
    await db
      .updateTable('enrollments')
      .set({
        status: 'waiting',
        next_run_at: scheduledTime.toISOString(),
      })
      .where('id', '=', enrollmentId)
      .execute();
  }

  private renderTemplate(tpl: string, lead: any): string {
    const map: Record<string, string> = {
      firstName: lead.first_name,
      lastName: lead.full_name.split(' ').slice(1).join(' '),
      fullName: lead.full_name,
      company: lead.company,
      title: lead.title,
      location: lead.location,
    };
    return tpl.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_, key, fb) => map[key] || fb || `{{${key}}}`);
  }
}
