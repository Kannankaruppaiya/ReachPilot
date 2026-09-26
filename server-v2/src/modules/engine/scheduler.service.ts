import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { profileKey, invitedProfileKeys } from '@/modules/jobs/profile-key';

/** LinkedIn account statuses that must NOT send. Jobs for these are re-deferred. */
const NON_SENDABLE_STATUSES = new Set(['checkpoint', 'paused', 'disconnected']);
/** Lead statuses that suppress all outreach (opt-out / do-not-contact). */
const SUPPRESSED_LEAD_STATUSES = new Set(['blacklisted', 'unqualified']);
/**
 * Why a campaign job must not go out now, or null. The string becomes the job's
 * `last_error`, which graph-executor's onCanceledJob reads on resume.
 */
export function sequenceHold(campaignStatus?: string, enrollmentStatus?: string): string | null {
  if (campaignStatus && campaignStatus !== 'active') return 'campaign_paused';
  if (enrollmentStatus === 'replied') return 'lead_replied';
  if (enrollmentStatus === 'paused') return 'enrollment_paused';
  if (enrollmentStatus === 'stopped' || enrollmentStatus === 'finished') return 'enrollment_inactive';
  return null;
}

/**
 * Re-check interval for jobs whose desktop agent is offline. AgentController
 * pulls them forward as soon as the agent reconnects.
 */
const AGENT_OFFLINE_DEFER_MS = 5 * 60_000;

/**
 * Drains due `scheduled` jobs into BullMQ after the sequence, suppression,
 * duplicate-invite, account-health and desktop-agent gates. Without it, sequences
 * never advance past day one. Scans each workspace under its own RLS context.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private redis: Redis | null = null;
  private linkedinQueue: Queue | null = null;
  private emailQueue: Queue | null = null;
  private ticking = false;

  private conn(): Redis {
    if (!this.redis) {
      this.redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    }
    return this.redis;
  }

  private queue(kind: 'linkedin' | 'email'): Queue {
    if (kind === 'linkedin') {
      if (!this.linkedinQueue) {
        this.linkedinQueue = new Queue('linkedin-actions', { connection: this.conn() as any });
      }
      return this.linkedinQueue;
    }
    if (!this.emailQueue) {
      this.emailQueue = new Queue('email-send', { connection: this.conn() as any });
    }
    return this.emailQueue;
  }

  /** One pass over all workspaces; guarded so a slow tick never overlaps the next. */
  async tick(): Promise<{ enqueued: number; deferred: number; suppressed: number }> {
    if (this.ticking) {
      this.logger.debug('Tick still running — skipping this interval');
      return { enqueued: 0, deferred: 0, suppressed: 0 };
    }
    this.ticking = true;
    const totals = { enqueued: 0, deferred: 0, suppressed: 0 };
    try {
      const workspaces = await getDb().selectFrom('workspaces').select('id').execute();
      for (const ws of workspaces) {
        try {
          const r = await this.drainWorkspace(ws.id);
          totals.enqueued += r.enqueued;
          totals.deferred += r.deferred;
          totals.suppressed += r.suppressed;
        } catch (err: any) {
          this.logger.warn({ workspaceId: ws.id, err: err.message }, 'Workspace drain failed');
        }
      }
      if (totals.enqueued || totals.deferred || totals.suppressed) {
        this.logger.log(
          `Scheduler tick: enqueued=${totals.enqueued} deferred=${totals.deferred} suppressed=${totals.suppressed}`,
        );
      }
    } finally {
      this.ticking = false;
    }
    return totals;
  }

  private async drainWorkspace(
    workspaceId: string,
  ): Promise<{ enqueued: number; deferred: number; suppressed: number }> {
    const nowIso = new Date().toISOString();
    let enqueued = 0;
    let deferred = 0;
    let suppressed = 0;
    // One heartbeat read per account per tick, not per job.
    const agentOnline = new Map<string, boolean>();

    // A bounded batch of due jobs, oldest first.
    const due = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('jobs')
        .selectAll()
        // Explicit scope: the BYPASSRLS production role would otherwise see every tenant.
        .where('workspace_id', '=', workspaceId)
        .where('status', '=', 'scheduled')
        .where('scheduled_for', '<=', nowIso as any)
        .orderBy('scheduled_for', 'asc')
        .limit(100)
        .execute(),
    );

    if (due.length === 0) return { enqueued, deferred, suppressed };

    const payloadOf = (j: any): { target?: string; resolvedSlug?: string } => {
      if (!j?.payload) return {};
      if (typeof j.payload !== 'string') return j.payload;
      try {
        return JSON.parse(j.payload);
      } catch {
        return {};
      }
    };

    // Built once per drain, only if a job in this batch needs it.
    let invited: Set<string> | null = null;
    const invitedKeys = async (): Promise<Set<string>> => {
      if (!invited) {
        const sent = await withWorkspace(workspaceId, (db) =>
          db
            .selectFrom('jobs')
            .select('payload')
            // This workspace's invites only.
            .where('workspace_id', '=', workspaceId)
            .where('action', '=', 'connect_request')
            .where('status', '=', 'sent')
            .execute(),
        );
        invited = invitedProfileKeys(sent.map(payloadOf));
      }
      return invited;
    };

    // Campaign + enrollment states for this batch, read once per drain.
    const campaignIds = [...new Set(due.map((j) => j.campaign_id).filter(Boolean))] as string[];
    const enrollmentIds = [...new Set(due.map((j) => j.enrollment_id).filter(Boolean))] as string[];
    const { campaignStatus, enrollmentStatus } = await withWorkspace(workspaceId, async (db) => {
      const camps = campaignIds.length
        ? await db
            .selectFrom('campaigns')
            .select(['id', 'status'])
            .where('workspace_id', '=', workspaceId)
            .where('id', 'in', campaignIds)
            .execute()
        : [];
      const enrs = enrollmentIds.length
        ? await db
            .selectFrom('enrollments')
            .select(['id', 'status'])
            .where('workspace_id', '=', workspaceId)
            .where('id', 'in', enrollmentIds)
            .execute()
        : [];
      return {
        campaignStatus: new Map(camps.map((c) => [c.id as string, c.status as string])),
        enrollmentStatus: new Map(enrs.map((e) => [e.id as string, e.status as string])),
      };
    });

    for (const job of due) {
      const kind = (job.kind === 'email' ? 'email' : 'linkedin') as 'linkedin' | 'email';

      // --- Sequence gate: a paused campaign or paused/replied lead sends nothing. ---
      const hold = sequenceHold(
        job.campaign_id ? campaignStatus.get(job.campaign_id) : undefined,
        job.enrollment_id ? enrollmentStatus.get(job.enrollment_id) : undefined,
      );
      if (hold) {
        await withWorkspace(workspaceId, (db) =>
          db
            .updateTable('jobs')
            .set({ status: 'canceled', last_error: hold })
            .where('workspace_id', '=', workspaceId)
            .where('id', '=', job.id)
            .execute(),
        );
        suppressed++;
        continue;
      }

      // --- Suppression gate: never contact opted-out / disqualified leads. ---
      if (job.lead_id) {
        const lead = await withWorkspace(workspaceId, (db) =>
          db.selectFrom('leads').select('status').where('id', '=', job.lead_id!).executeTakeFirst(),
        );
        if (lead && SUPPRESSED_LEAD_STATUSES.has(lead.status as string)) {
          await withWorkspace(workspaceId, (db) =>
            db
              .updateTable('jobs')
              .set({ status: 'canceled', last_error: `suppressed:${lead.status}` })
              .where('id', '=', job.id)
              .execute(),
          );
          suppressed++;
          continue;
        }

      }

      // --- Duplicate-invite guard: never invite the same person twice. Matched on
      //     the profile key in the payload, because connect jobs carry no lead_id. ---
      if (job.action === 'connect_request') {
        const key = profileKey(payloadOf(job).target);
        if (key && (await invitedKeys()).has(key)) {
          await withWorkspace(workspaceId, (db) =>
            db.updateTable('jobs').set({ status: 'canceled', last_error: 'duplicate_invite' }).where('id', '=', job.id).execute(),
          );
          suppressed++;
          continue;
        }
      }

      // --- Account-health gate: don't drive a flagged/paused account. ---
      if (kind === 'linkedin' && job.linkedin_account_id) {
        const acct = await withWorkspace(workspaceId, (db) =>
          db
            .selectFrom('linkedin_accounts')
            .select('status')
            .where('id', '=', job.linkedin_account_id!)
            .executeTakeFirst(),
        );
        if (acct && NON_SENDABLE_STATUSES.has(acct.status as string)) {
          // Hold the job; retry in an hour.
          const retryAt = new Date(Date.now() + 3600_000).toISOString();
          await withWorkspace(workspaceId, (db) =>
            db
              .updateTable('jobs')
              .set({ scheduled_for: retryAt as any, last_error: `account_${acct.status}` })
              .where('id', '=', job.id)
              .execute(),
          );
          deferred++;
          continue;
        }
      }

      // --- Desktop-agent gate: with the laptop closed nobody can run the action, so
      //     defer here instead of cycling the job through BullMQ and the worker.
      //     `last_error` MUST stay 'agent_unavailable': AgentController's
      //     wake-on-reconnect matches on it. ---
      if (kind === 'linkedin' && job.linkedin_account_id && getEnv().LINKEDIN_DRIVER === 'remote') {
        const acctId = job.linkedin_account_id;
        let online = agentOnline.get(acctId);
        if (online === undefined) {
          online = !!(await this.conn().get(`agent:hb:${acctId}`));
          agentOnline.set(acctId, online);
        }
        if (!online) {
          const retryAt = new Date(Date.now() + AGENT_OFFLINE_DEFER_MS).toISOString();
          await withWorkspace(workspaceId, (db) =>
            db
              .updateTable('jobs')
              .set({ scheduled_for: retryAt as any, last_error: 'agent_unavailable' })
              .where('id', '=', job.id)
              .execute(),
          );
          deferred++;
          continue;
        }
      }

      // --- Enqueue. Claim the row first (status → queued) so a concurrent tick can't
      //     double-enqueue; the jobId also dedupes in BullMQ. ---
      await withWorkspace(workspaceId, (db) =>
        db.updateTable('jobs').set({ status: 'queued' }).where('id', '=', job.id).execute(),
      );

      let payload: any = {};
      try {
        payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload || {};
      } catch {
        payload = {};
      }

      try {
        await this.queue(kind).add(
          kind === 'linkedin' ? 'linkedin-connect' : 'email-send',
          { jobId: job.id, workspaceId, leadId: job.lead_id, payload },
          // A finished job left in Redis would block a re-add with the same jobId and
          // strand the row in "queued".
          {
            jobId: job.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
        enqueued++;
      } catch (err: any) {
        // Redis unreachable: roll back the claim so the next tick retries.
        await withWorkspace(workspaceId, (db) =>
          db.updateTable('jobs').set({ status: 'scheduled' }).where('id', '=', job.id).execute(),
        );
        this.logger.warn({ jobId: job.id, err: err.message }, 'Enqueue failed — reverted to scheduled');
      }
    }

    return { enqueued, deferred, suppressed };
  }
}
