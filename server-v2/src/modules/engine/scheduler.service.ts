import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { profileKey, invitedProfileKeys } from '@/modules/jobs/profile-key';

/**
 * The missing heart of the outreach engine.
 *
 * Jobs are inserted as `status='scheduled'` with a `scheduled_for` timestamp by
 * the batch/graph executors — but only the ones due *right now* get pushed to
 * BullMQ immediately. Everything with a future `scheduled_for` (follow-ups,
 * next-day drips, pacing-deferred retries) just sits in Postgres.
 *
 * This service is what drains that backlog: on each tick it finds jobs whose
 * time has come, gates them (account health + suppression), and hands them to
 * the right BullMQ queue. Without it, a multi-day sequence never advances past
 * day one.
 *
 * `jobs` is RLS-scoped, so we enumerate workspaces (not RLS'd) and scan each
 * under its own tenant context — the same pattern the Gmail inbox sync uses.
 */

/** LinkedIn account statuses that must NOT send. Jobs for these are re-deferred. */
const NON_SENDABLE_STATUSES = new Set(['checkpoint', 'paused', 'disconnected']);
/** Lead statuses that suppress all outreach (opt-out / do-not-contact). */
const SUPPRESSED_LEAD_STATUSES = new Set(['blacklisted', 'unqualified']);
/** How long to hold a job whose desktop agent is offline. Recovery does NOT wait
 *  this out: AgentController pulls these forward the moment the agent reappears,
 *  so the value only decides how often we re-check a laptop that stays shut. */
const AGENT_OFFLINE_DEFER_MS = 5 * 60_000;

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

  /**
   * One pass over all workspaces. Re-entrancy guarded so a slow tick never
   * overlaps the next interval (which would double-enqueue).
   */
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
    // One heartbeat read per ACCOUNT per tick, not per job — a 100-job backlog on
    // one account is the normal shape here, and it needs one Redis GET, not 100.
    const agentOnline = new Map<string, boolean>();

    // Pull a bounded batch of due jobs. Ordered oldest-first so backlog drains fairly.
    const due = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('jobs')
        .selectAll()
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

    // Built once per drain, and only when something in this batch could need it —
    // not once per job, which would re-read the whole sent history each time.
    let invited: Set<string> | null = null;
    const invitedKeys = async (): Promise<Set<string>> => {
      if (!invited) {
        const sent = await withWorkspace(workspaceId, (db) =>
          db
            .selectFrom('jobs')
            .select('payload')
            .where('action', '=', 'connect_request')
            .where('status', '=', 'sent')
            .execute(),
        );
        invited = invitedProfileKeys(sent.map(payloadOf));
      }
      return invited;
    };

    for (const job of due) {
      const kind = (job.kind === 'email' ? 'email' : 'linkedin') as 'linkedin' | 'email';

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

      // --- Duplicate-invite guard: never send a second connection request to
      //     someone we've already invited (a double-touch that annoys prospects
      //     and wastes weekly-invite quota).
      //
      // 🔴 Deliberately OUTSIDE the `job.lead_id` block above. This used to live
      // inside it and look the lead up by id — but connect jobs carry `lead_id`
      // NULL (366 of 366 on live data), so the block was skipped entirely and the
      // guard never fired once. Dinesh M ended up with three jobs on one target;
      // one sent, and a later duplicate still ran. The profile key is always in
      // the payload, so match on that. ---
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
          // Hold the job — retry in an hour once the account recovers.
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

      // --- Desktop-agent gate: in remote mode the executor is the USER'S LAPTOP.
      //     With it closed there is nobody to run the action, so stop here rather
      //     than dragging the job through BullMQ → worker → pacing → driver only
      //     to have the driver miss the same heartbeat and defer it anyway. That
      //     round trip costs a queue add, a worker slot, a pacing register and its
      //     rollback, and several DB writes — repeated every few minutes, all
      //     night, for every job in the backlog.
      //
      //     `last_error` MUST stay 'agent_unavailable': that is the marker
      //     AgentController's wake-on-reconnect matches on to pull the backlog
      //     forward when the laptop comes back. ---
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

      // --- Enqueue. Claim the row first (status→queued) so a concurrent tick
      //     or restart can't double-enqueue; jobId dedupes at the BullMQ layer. ---
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
          // removeOnComplete/Fail: a finished BullMQ job left in Redis blocks a
          // later re-add with the same jobId (silent dedupe), which strands a
          // deferred row in "queued" forever.
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
        // Couldn't reach Redis — roll the claim back so the next tick retries.
        await withWorkspace(workspaceId, (db) =>
          db.updateTable('jobs').set({ status: 'scheduled' }).where('id', '=', job.id).execute(),
        );
        this.logger.warn({ jobId: job.id, err: err.message }, 'Enqueue failed — reverted to scheduled');
      }
    }

    return { enqueued, deferred, suppressed };
  }
}
