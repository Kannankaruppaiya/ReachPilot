import { Injectable, BadRequestException } from '@nestjs/common';
import { sql } from 'kysely';
import { withWorkspace } from '@/db/rls';
import { sendableMailboxes } from '@/modules/accounts/mailbox';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';
import { computeWarmup, warmupOrigin } from '@/modules/engine/warmup';
import { profileKey, profileKeyFromSlug, selectNewRows } from './profile-key';
import { spin } from '@/modules/engine/spintax';
import { isRequeueableFailure } from '@/modules/drivers/linkedin-driver.interface';

let redisClient: Redis | null = null;
let linkedinQueue: Queue | null = null;
let emailQueue: Queue | null = null;

/** Extract the `/in/<slug>` handle from a LinkedIn URL (for lead↔job matching). */
const profileSlug = (url?: string | null): string =>
  (String(url || '').match(/\/in\/([^/?#]+)/i)?.[1] || '').toLowerCase();

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
export class JobsService {
  async listJobs(
    workspaceId: string,
    kind?: string,
    batchId?: string,
  ): Promise<any[]> {
    return withWorkspace(workspaceId, async (db) => {
      let query = db
        .selectFrom('jobs')
        .selectAll()
        .where('workspace_id', '=', workspaceId);

      if (kind) {
        query = query.where('kind', '=', kind as any);
      }
      if (batchId) {
        query = query.where('batch_id', '=', batchId);
      }

      const rows = await query.orderBy('created_at', 'asc').execute();
      return rows.map((r) => this.mapToFrontend(r));
    });
  }

  /**
   * The workspace's connection-request jobs, newest first, each with its outcome
   * (pending → accepted → replied) joined from the lead by profile slug.
   */
  async listConnections(workspaceId: string): Promise<any[]> {
    return withWorkspace(workspaceId, async (db) => {
      const jobs = await db
        .selectFrom('jobs')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('kind', '=', 'linkedin')
        .where('action', '=', 'connect_request' as any)
        .orderBy('created_at', 'desc')
        .execute();

      // Match leads by slug in memory: URLs differ by trailing slash or query.
      const leads = await db
        .selectFrom('leads')
        .select(['linkedin_url', 'status', 'last_activity'])
        .where('workspace_id', '=', workspaceId)
        .where('linkedin_url', 'is not', null)
        .execute();
      const bySlug = new Map<string, { status: string; lastActivity: string | null }>();
      for (const l of leads) {
        const slug = profileSlug(l.linkedin_url as string | null);
        if (slug) bySlug.set(slug, { status: l.status as string, lastActivity: (l as any).last_activity ?? null });
      }

      const rows = jobs.map((j) => this.mapConnection(j, bySlug));
      const summary = {
        total: rows.length,
        sent: rows.filter((r) => r.delivery === 'sent').length,
        accepted: rows.filter((r) => r.outcome === 'accepted').length,
        replied: rows.filter((r) => r.outcome === 'replied').length,
        pending: rows.filter((r) => r.outcome === 'pending').length,
        inQueue: rows.filter((r) => r.outcome === 'in_queue').length,
        failed: rows.filter((r) => r.outcome === 'failed').length,
      };
      const deliveredForRate = summary.accepted + summary.replied + summary.pending;
      const acceptanceRate =
        deliveredForRate > 0 ? Math.round(((summary.accepted + summary.replied) / deliveredForRate) * 100) : 0;

      return { summary: { ...summary, acceptanceRate }, rows } as any;
    });
  }

  /** Shape one connection-request job for the Connections page. */
  private mapConnection(
    r: any,
    bySlug: Map<string, { status: string; lastActivity: string | null }>,
  ) {
    let p = { name: '', target: '', company: '', role: '', message: '', subject: '' };
    try {
      p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
    } catch {}

    const slug = profileSlug(p.target);
    const lead = slug ? bySlug.get(slug) : undefined;
    const delivery: string = r.status; // scheduled | queued | running | sent | failed | canceled

    let outcome: 'in_queue' | 'pending' | 'accepted' | 'replied' | 'failed';
    if (delivery === 'failed' || delivery === 'canceled') outcome = 'failed';
    else if (delivery === 'sent') {
      outcome = lead?.status === 'replied' ? 'replied' : lead?.status === 'accepted' ? 'accepted' : 'pending';
    } else outcome = 'in_queue'; // scheduled | queued | running

    return {
      id: r.id,
      batchId: r.batch_id,
      name: p.name || '',
      linkedinUrl: p.target || '',
      company: p.company || '',
      role: p.role || '',
      message: p.message || '',
      delivery,
      outcome,
      leadStatus: lead?.status ?? null,
      lastActivity: lead?.lastActivity ?? null,
      sentAt: r.sent_at || null,
      scheduledFor: r.scheduled_for,
      error: r.last_error || null,
      createdAt: r.created_at,
    };
  }

  /**
   * Cancel one unsent job. The 'canceled' status makes the worker skip it even if
   * BullMQ already dequeued it; removal from BullMQ is best-effort.
   */
  async cancelJob(workspaceId: string, jobId: string): Promise<{ ok: true; canceled: boolean }> {
    const canceled = await withWorkspace(workspaceId, async (db) => {
      const res = await db
        .updateTable('jobs')
        .set({ status: 'canceled', last_error: 'canceled_by_user' })
        .where('id', '=', jobId)
        .where('workspace_id', '=', workspaceId)
        .where('status', 'in', ['scheduled', 'queued', 'running'] as any)
        .executeTakeFirst();
      return Number(res.numUpdatedRows ?? 0) > 0;
    });

    // Best-effort; an already-active job is covered by the 'canceled' status.
    await getQueue('linkedin-actions').remove(jobId).catch(() => undefined);
    await getQueue('email-send').remove(jobId).catch(() => undefined);

    return { ok: true, canceled };
  }

  /**
   * Hard-delete jobs by `{ id }` or `{ statuses, kind }`, from Postgres and
   * (best-effort) BullMQ. A deleted row BullMQ still delivers is skipped by the worker.
   */
  async deleteJobs(
    workspaceId: string,
    opts: { id?: string; statuses?: string[]; kind?: string },
  ): Promise<{ deleted: number }> {
    const ids = await withWorkspace(workspaceId, async (db) => {
      let q = db.selectFrom('jobs').select('id').where('workspace_id', '=', workspaceId);
      if (opts.id) q = q.where('id', '=', opts.id);
      if (opts.kind) q = q.where('kind', '=', opts.kind as any);
      if (opts.statuses && opts.statuses.length) q = q.where('status', 'in', opts.statuses as any);
      const rows = await q.execute();
      return rows.map((r) => r.id);
    });
    if (ids.length === 0) return { deleted: 0 };

    await withWorkspace(workspaceId, (db) =>
      db.deleteFrom('jobs').where('workspace_id', '=', workspaceId).where('id', 'in', ids).execute(),
    );
    for (const id of ids) {
      await getQueue('linkedin-actions').remove(id).catch(() => undefined);
      await getQueue('email-send').remove(id).catch(() => undefined);
    }
    return { deleted: ids.length };
  }

  /**
   * Re-queue failed leads whose failure said nothing about the lead (e.g. the
   * account was signed out). `isRequeueableFailure` only admits failures that
   * provably happened before anything was sent. Spread over the next hour.
   */
  async requeueFailed(
    workspaceId: string,
    kind = 'linkedin',
  ): Promise<{ requeued: number; skipped: number }> {
    const failed = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('jobs')
        .select(['id', 'last_error'])
        .where('workspace_id', '=', workspaceId)
        .where('kind', '=', kind as any)
        .where('status', '=', 'failed' as any)
        .execute(),
    );

    const ids = failed
      .filter((j) => isRequeueableFailure(j.last_error as string | null))
      .map((j) => j.id);
    if (ids.length === 0) return { requeued: 0, skipped: failed.length };

    await withWorkspace(workspaceId, (db) =>
      db
        .updateTable('jobs')
        .set({
          status: 'scheduled' as any,
          attempts: 0,
          last_error: 'requeued_by_user',
          scheduled_for: sql<string>`now() + (random() * interval '60 minutes')` as any,
        })
        .where('workspace_id', '=', workspaceId)
        .where('id', 'in', ids)
        .execute(),
    );

    return { requeued: ids.length, skipped: failed.length - ids.length };
  }

  async createBatch(
    workspaceId: string,
    kind: 'linkedin' | 'email',
    cap: number,
    rows: any[],
    template: string,
    subject?: string,
    personalization: { useAi?: boolean; useApify?: boolean; aiGuidance?: string; noNote?: boolean } = {},
  ): Promise<{ batchId: string; total: number; today: number; queuedDays: number; skipped: number }> {
    if (kind !== 'linkedin' && kind !== 'email') {
      throw new BadRequestException('Invalid channel.');
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('No profiles to send to.');
    }

    // Skip profiles this workspace already sent an invite to: a repeat invite
    // wastes weekly allowance and looks automated. Only SENT jobs count.
    let skipped = 0;
    if (kind === 'linkedin') {
      const sentJobs = await withWorkspace(workspaceId, (db) =>
        db
          .selectFrom('jobs')
          .select('payload')
          .where('workspace_id', '=', workspaceId)
          .where('action', '=', 'connect_request')
          .where('status', '=', 'sent')
          .execute(),
      );

      const sentKeys = new Set<string>();
      for (const j of sentJobs) {
        const p: any =
          typeof j.payload === 'string'
            ? (() => {
                try {
                  return JSON.parse(j.payload);
                } catch {
                  return {};
                }
              })()
            : j.payload || {};
        // Match on both the given URL and the vanity slug LinkedIn served.
        // resolvedSlug is a bare slug, so it goes through profileKeyFromSlug.
        const targetKey = profileKey(p.target);
        if (targetKey) sentKeys.add(targetKey);
        const resolvedKey = profileKeyFromSlug(p.resolvedSlug);
        if (resolvedKey) sentKeys.add(resolvedKey);
      }

      const selection = selectNewRows(rows, sentKeys);
      skipped = selection.skipped.length;
      rows = selection.kept;

      if (rows.length === 0) {
        // Every profile was already contacted: a normal outcome, not an error.
        return { batchId: '', total: 0, today: 0, queuedDays: 0, skipped };
      }
    }

    const batchId = crypto.randomUUID();

    // Enqueue day-one jobs only after the transaction commits; otherwise the worker
    // can receive a job before its row is visible and orphan it.
    const toEnqueue: { jobId: string; leadId: any; payload: unknown }[] = [];

    const result = await withWorkspace(workspaceId, async (db) => {
      // First active LinkedIn account for this workspace.
      const linkedinAcct = await db
        .selectFrom('linkedin_accounts')
        .select(['id', 'warmup_daily_limit', 'warmup_target', 'connected_at', 'created_at', 'hours_start', 'hours_end', 'timezone'])
        .where('workspace_id', '=', workspaceId)
        .limit(1)
        .executeTakeFirst();

      // LinkedIn batches always use the account's limits (Settings); the client cap
      // only applies to email.
      const perDay =
        kind === 'linkedin' && linkedinAcct
          ? computeWarmup(
              warmupOrigin(linkedinAcct.connected_at, linkedinAcct.created_at),
              linkedinAcct.warmup_daily_limit,
              linkedinAcct.warmup_target,
            ).todayLimit
          : Math.max(1, Number(cap) || 15);

      const emailAcct = await sendableMailboxes(db, workspaceId).select('id').executeTakeFirst();

      const createdJobs: any[] = [];

      // Schedule in the account's timezone. Each day's whole quota becomes due at the
      // window open (not a slot grid): the executor is the user's laptop, so the
      // queue drains whenever it is on. Pacing still enforces every limit at send time.
      const tz = (kind === 'linkedin' && linkedinAcct?.timezone) || 'UTC';
      const parseMin = (hhmm: any, def: number) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
        return m ? Number(m[1]) * 60 + Number(m[2]) : def;
      };
      // Only the open matters here; pacing handles the close (and midnight wraps).
      const startMin = kind === 'linkedin' ? parseMin(linkedinAcct?.hours_start, 9 * 60) : 9 * 60;

      // A bare "linkedin.com/in/x" is a relative path to the UI and the driver.
      const withProtocol = (u: any): string => {
        const s = String(u || '').trim();
        if (!s) return '';
        return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
      };

      // Today in the account timezone (en-CA formats as YYYY-MM-DD).
      const [ty, tm, td] = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(new Date())
        .split('-')
        .map(Number);

      // Account wall-clock → UTC. Up to ~1h off across DST; pacing re-checks.
      const wallToUtc = (dayOffset: number, minsFromMidnight: number): Date => {
        const guess = Date.UTC(ty, tm - 1, td + dayOffset, 0, minsFromMidnight, 0);
        const p: any = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
          .formatToParts(new Date(guess))
          .reduce((a: any, x) => ((a[x.type] = x.value), a), {});
        const asUtc = Date.UTC(
          Number(p.year),
          Number(p.month) - 1,
          Number(p.day),
          Number(p.hour === '24' ? 0 : p.hour),
          Number(p.minute),
          Number(p.second),
        );
        return new Date(guess - (asUtc - guess));
      };

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const dayOffset = Math.floor(i / perDay);
        const scheduledFor = wallToUtc(dayOffset, startMin);

        const isToday = dayOffset === 0;
        const status = isToday ? 'queued' : 'scheduled';
        const jobId = crypto.randomUUID();

        const payload = {
          name: row.name || '',
          target:
            kind === 'linkedin'
              ? withProtocol(row.target || row.linkedinUrl)
              : row.target || row.linkedinUrl || row.email || '',
          company: row.company || '',
          role: row.role || row.title || '',
          // Template fallback; with AI on, the worker writes the real note at send time.
          message: this.fillTemplate(template, row),
          subject: this.fillTemplate(subject || '', row),
          ...(kind === 'linkedin' && personalization.useAi
            ? {
                useAi: true,
                useApify: !!personalization.useApify,
                aiGuidance: personalization.aiGuidance || '',
              }
            : {}),
          // Send without a note: the worker skips the note entirely.
          ...(kind === 'linkedin' && personalization.noNote ? { noNote: true } : {}),
        };

        const jobData = {
          id: jobId,
          workspace_id: workspaceId,
          batch_id: batchId,
          linkedin_account_id: linkedinAcct?.id || null,
          email_account_id: emailAcct?.id || null,
          lead_id: row.leadId || null,
          kind,
          action: kind === 'linkedin' ? 'connect_request' : 'send_email',
          payload: JSON.stringify(payload),
          status,
          scheduled_for: scheduledFor.toISOString(),
          idempotency_key: `batch:${batchId}:job:${i}`,
        };

        await db
          .insertInto('jobs')
          .values(jobData as any)
          .execute();

        createdJobs.push(jobData);

        if (isToday) toEnqueue.push({ jobId, leadId: row.leadId, payload });
      }

      const todayCount = createdJobs.filter((j) => j.status === 'queued').length;
      const totalCount = createdJobs.length;
      const queuedDays = Math.ceil(totalCount / perDay);

      await db
        .insertInto('activity')
        .values({
          workspace_id: workspaceId,
          text:
            `Queued ${totalCount} ${kind === 'linkedin' ? 'connection requests' : 'emails'} (${todayCount} today)` +
            (skipped ? ` · skipped ${skipped} already contacted` : ''),
          tone: 'accent',
        })
        .execute();

      return { batchId, total: totalCount, today: todayCount, queuedDays, skipped };
    });

    // Committed: rows are now visible to the worker.
    if (toEnqueue.length) {
      const queueObj = getQueue(kind === 'linkedin' ? 'linkedin-actions' : 'email-send');
      for (const e of toEnqueue) {
        await queueObj.add(
          kind === 'linkedin' ? 'linkedin-connect' : 'email-send',
          { jobId: e.jobId, workspaceId, leadId: e.leadId, payload: e.payload },
          {
            jobId: e.jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            // A finished job left in Redis would block a re-add with the same jobId.
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      }
    }

    return result;
  }

  /** Fill {{firstName}}/{{company}}/{{role}}, then resolve spintax (see spintax.ts). */
  private fillTemplate(tpl: string, row: any): string {
    const firstName = String(row.name || '').trim().split(/\s+/)[0] || 'there';
    const filled = String(tpl || '')
      .replace(/\{\{\s*firstName\s*\}\}/g, firstName)
      .replace(/\{\{\s*company\s*\}\}/g, row.company || 'your company')
      .replace(/\{\{\s*role\s*\}\}/g, row.role || row.title || 'your role');
    return spin(filled);
  }

  private mapToFrontend(r: any) {
    let payloadParsed = { name: '', target: '', company: '', role: '', message: '', subject: '' };
    try {
      payloadParsed = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
    } catch {}

    const day = Math.floor((new Date(r.scheduled_for).getTime() - new Date().setHours(0,0,0,0)) / 86400000);

    return {
      id: r.id,
      batchId: r.batch_id,
      kind: r.kind,
      leadId: r.lead_id,
      name: payloadParsed.name,
      target: payloadParsed.target,
      company: payloadParsed.company,
      role: payloadParsed.role,
      message: payloadParsed.message,
      subject: payloadParsed.subject,
      day: Math.max(0, day),
      status: r.status,
      scheduledFor: r.scheduled_for,
      sentAt: r.sent_at || null,
      createdAt: r.created_at,
    };
  }
}
