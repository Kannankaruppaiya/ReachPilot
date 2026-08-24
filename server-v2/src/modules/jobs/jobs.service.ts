import { Injectable, BadRequestException } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';
import { computeWarmup } from '@/modules/engine/warmup';
import { spin } from '@/modules/engine/spintax';

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
   * All LinkedIn connection-request jobs for the workspace, newest first, each
   * enriched with its post-send OUTCOME. Delivery status comes from the job row
   * (queued → sent/failed); the outcome (pending → accepted → replied) is joined
   * from the matching lead by LinkedIn profile slug, since the acceptance/reply
   * sync writes onto the leads table keyed by profile URL.
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

      // Build a slug → lead-outcome map once, then merge in memory (URLs differ
      // by trailing slash / query, so a slug match is more reliable than SQL eq).
      const leads = await db
        .selectFrom('leads')
        .select(['linkedin_url', 'status', 'last_activity'])
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

    // Outcome: the human-meaningful state of the connection attempt.
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
   * Cancel a single not-yet-sent job (the queue "close" button). Sets the row to
   * 'canceled' — the worker's idempotency guard then skips it even if BullMQ has
   * already dequeued it — and best-effort removes it from BullMQ so a queued job
   * never spins up a browser. Sent/failed/already-canceled jobs are left as-is.
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

    // Best-effort: drop the delayed/waiting BullMQ job so it doesn't fire at all.
    // (Already-active jobs can't be removed; the DB 'canceled' status covers those.)
    await getQueue('linkedin-actions').remove(jobId).catch(() => undefined);
    await getQueue('email-send').remove(jobId).catch(() => undefined);

    return { ok: true, canceled };
  }

  /**
   * Hard-delete jobs (the queue "delete" button + "clear" bulk action). Removes
   * the rows from Postgres AND best-effort from BullMQ so nothing fires. Safe for
   * any status: a deleted 'queued' row that BullMQ still dequeues is skipped by
   * the worker's `if (!jobRow) return` guard.
   *
   *  - { id }               → delete one job
   *  - { statuses, kind }   → bulk delete (e.g. clear the queue / wipe for a fresh test)
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
    // Best-effort: drop any still-pending BullMQ jobs so a deleted row never fires.
    for (const id of ids) {
      await getQueue('linkedin-actions').remove(id).catch(() => undefined);
      await getQueue('email-send').remove(id).catch(() => undefined);
    }
    return { deleted: ids.length };
  }

  async createBatch(
    workspaceId: string,
    kind: 'linkedin' | 'email',
    cap: number,
    rows: any[],
    template: string,
    subject?: string,
    personalization: { useAi?: boolean; useApify?: boolean; aiGuidance?: string; noNote?: boolean } = {},
  ): Promise<{ batchId: string; total: number; today: number; queuedDays: number }> {
    if (kind !== 'linkedin' && kind !== 'email') {
      throw new BadRequestException('Invalid channel.');
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('No profiles to send to.');
    }

    const batchId = crypto.randomUUID();

    // Jobs to hand to BullMQ AFTER the DB transaction commits. Enqueuing inside
    // the transaction is a race: BullMQ (Redis) delivers the job to the worker
    // before Postgres commits, so the worker's RLS-scoped lookup can't see the
    // still-uncommitted row → it skips the job as "missing" and the row orphans
    // (the scheduler only re-runs 'scheduled' rows, never 'queued'). Collect
    // day-one sends here and enqueue them once the transaction has committed.
    const toEnqueue: { jobId: string; leadId: any; payload: unknown }[] = [];

    // All inserts run under the workspace's RLS context.
    const result = await withWorkspace(workspaceId, async (db) => {
      // Find first active LinkedIn/email account for this workspace to link
      const linkedinAcct = await db
        .selectFrom('linkedin_accounts')
        .select(['id', 'warmup_daily_limit', 'warmup_target', 'connected_at', 'created_at', 'hours_start', 'hours_end', 'timezone'])
        .where('workspace_id', '=', workspaceId)
        .limit(1)
        .executeTakeFirst();

      // LinkedIn batches are ALWAYS paced by the account's limit (Settings →
      // LinkedIn limits + warm-up ramp) — the client-sent cap is ignored so the
      // settings page stays the single place limits are controlled. Email batches
      // still honor the requested cap.
      const perDay =
        kind === 'linkedin' && linkedinAcct
          ? computeWarmup(
              linkedinAcct.connected_at || linkedinAcct.created_at,
              linkedinAcct.warmup_daily_limit,
              linkedinAcct.warmup_target,
            ).todayLimit
          : Math.max(1, Number(cap) || 15);

      const emailAcct = await db
        .selectFrom('email_accounts')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .limit(1)
        .executeTakeFirst();

      const createdJobs: any[] = [];

      // Schedule in the ACCOUNT's timezone + working hours (NOT the server clock).
      // Old code hardcoded setHours(9) which, on a UTC server, meant 9am UTC =
      // 2:30pm IST and ignored the account's hours_start entirely. Now each day's
      // quota starts at the account's working-hours open and is spread evenly
      // across the [hours_start, hours_end] window so sends trickle through the
      // day instead of all stacking at one instant (pacing still enforces the
      // per-action minimum gap at send time).
      const tz = (kind === 'linkedin' && linkedinAcct?.timezone) || 'UTC';
      const parseMin = (hhmm: any, def: number) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
        return m ? Number(m[1]) * 60 + Number(m[2]) : def;
      };
      const startMin = kind === 'linkedin' ? parseMin(linkedinAcct?.hours_start, 9 * 60) : 9 * 60;
      let endMin = kind === 'linkedin' ? parseMin(linkedinAcct?.hours_end, 18 * 60) : 18 * 60;
      if (endMin <= startMin) endMin = startMin + 60; // guard a wrapped/empty window
      const windowMin = endMin - startMin;

      // Ensure every LinkedIn target URL carries a protocol. A bare
      // "linkedin.com/in/x" is treated as a RELATIVE path — the UI "Open" link
      // resolves it against the app domain (→ Vercel 404) and the driver's goto
      // fails (→ profile_gone / no_connect_button). Normalize once at job-create.
      const withProtocol = (u: any): string => {
        const s = String(u || '').trim();
        if (!s) return '';
        return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
      };

      // "Today" as a calendar date in the account timezone (YYYY-MM-DD).
      const [ty, tm, td] = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(new Date())
        .split('-')
        .map(Number);

      // Wall-clock (account tz) → UTC instant. One-pass offset correction; at most
      // ~1h off across a DST edge, which pacing re-checks and self-corrects.
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
        const positionInDay = i % perDay;
        // Spread evenly across the working window: first at the open, then stepped.
        const minsFromMidnight =
          perDay > 1 ? startMin + Math.round((windowMin * positionInDay) / perDay) : startMin;
        const scheduledFor = wallToUtc(dayOffset, minsFromMidnight);

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
          // Template is always filled as the fallback; when AI is on the worker
          // generates the real note at send time (and Apify enriches it).
          message: this.fillTemplate(template, row),
          subject: this.fillTemplate(subject || '', row),
          ...(kind === 'linkedin' && personalization.useAi
            ? {
                useAi: true,
                useApify: !!personalization.useApify,
                aiGuidance: personalization.aiGuidance || '',
              }
            : {}),
          // "Send without a note" — independent of AI; the worker drops the note
          // entirely (direct note-less connect, skips the note-cap check).
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

        // Day-one sends go to BullMQ — but only AFTER this transaction commits.
        if (isToday) toEnqueue.push({ jobId, leadId: row.leadId, payload });
      }

      const todayCount = createdJobs.filter((j) => j.status === 'queued').length;
      const totalCount = createdJobs.length;
      const queuedDays = Math.ceil(totalCount / perDay);

      // Log Activity
      await db
        .insertInto('activity')
        .values({
          workspace_id: workspaceId,
          text: `Queued ${totalCount} ${kind === 'linkedin' ? 'connection requests' : 'emails'} (${todayCount} today)`,
          tone: 'accent',
        })
        .execute();

      return { batchId, total: totalCount, today: todayCount, queuedDays };
    });

    // Transaction has committed — the rows are now visible to the worker's
    // separate connection, so it's safe to enqueue without the race above.
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
            // A finished BullMQ job left in Redis blocks a later re-add with the
            // same jobId (silent dedupe) — deferred jobs would never rerun.
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      }
    }

    return result;
  }

  /**
   * Fill {{firstName}}/{{company}}/{{role}} placeholders from a row's fields,
   * then resolve spintax groups (`{Hi|Hey|Hello}`) so each recipient gets a
   * unique variation. Variables first, spin second — see spintax.ts.
   */
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
