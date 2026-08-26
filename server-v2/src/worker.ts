import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';
import { withWorkspace } from '@/db/rls';
import { LINKEDIN_DRIVER, EMAIL_DRIVER } from '@/modules/drivers/driver.tokens';
import { LinkedInSessionService } from '@/modules/drivers/linkedin-session.service';
import { getLoginQueue } from '@/modules/accounts/linkedin-accounts.service';
import { connectWithNoteFallback } from '@/modules/drivers/connect-with-fallback';
import { ConnectionNoteService } from '@/modules/ai/connection-note.service';
import {
  LinkedInDriver,
  LinkedInActionResult,
  SKIP_OUTCOMES,
  ACCOUNT_HALT_OUTCOMES,
  TERMINAL_FAIL_OUTCOMES,
  DEFER_OUTCOMES,
} from '@/modules/drivers/linkedin-driver.interface';
import { serializeSession } from '@/modules/drivers/linkedin-session-store';
import { EmailDriver } from '@/modules/drivers/email-driver.interface';
import { SecretsService } from '@/modules/vault/secrets.service';
import { PacingService } from '@/modules/engine/pacing.service';
import { GmailInboxService } from '@/modules/integrations/gmail-inbox.service';
import { SchedulerService } from '@/modules/engine/scheduler.service';
import { CampaignRunnerService } from '@/modules/engine/campaign-runner.service';
import { LinkedInSyncService } from '@/modules/drivers/linkedin-sync.service';
import { EmailWarmupService } from '@/modules/drivers/email-warmup.service';
import { LeadScraperService } from '@/modules/scraping/lead-scraper.service';
import { ScrapeCursorService } from '@/modules/scraping/scrape-cursor.service';
import { ScrapeJobsService } from '@/modules/scraping/scrape-jobs.service';
import { LeadsService } from '@/modules/leads/leads.service';
import pino from 'pino';

const logger = pino({ name: 'worker' });

// Keep the worker alive through transient infra blips (Supabase pooler dropping a
// connection mid-query → in-flight query rejection / active-client 'error'). Without
// these, either one exits the process ("Connection terminated unexpectedly" exit 1).
// Deferred/failed jobs are re-driven by the scheduler, so logging + staying up is correct.
process.on('unhandledRejection', (reason: any) => {
  logger.warn(`Unhandled rejection (non-fatal): ${reason?.message || reason}`);
});
process.on('uncaughtException', (err: any) => {
  logger.error(`Uncaught exception (kept alive): ${err?.message || err}`);
});

const nowIso = () => new Date().toISOString();
const localDate = () => new Date().toLocaleDateString('en-US');

/**
 * Offload a scrape to the standalone scraper microservice (headful Chrome under
 * Xvfb on a VPS) when SCRAPER_SERVICE_URL is set. Best-effort: any failure throws
 * so the caller can fall back to scraping locally in-process.
 */
async function scrapeViaService(
  serviceUrl: string,
  token: string,
  body: { titles: string[]; location?: string; maxResults?: number; startPage?: number; pages?: number },
): Promise<any[]> {
  const res = await fetch(`${serviceUrl.replace(/\/$/, '')}/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000), // a paginated scrape can run a while
  });
  if (!res.ok) throw new Error(`scraper service ${res.status}`);
  const data: any = await res.json();
  if (!data?.ok || !Array.isArray(data.leads)) throw new Error('scraper service bad response');
  return data.leads;
}

/** Human-readable activity label per LinkedIn action type. */
const ACTION_LABEL: Record<string, string> = {
  connect_request: 'Connection request sent',
  linkedin_message: 'Message sent',
  inmail: 'InMail sent',
  follow: 'Followed profile',
  visit_profile: 'Profile viewed',
  like_post: 'Post liked',
  endorse_skill: 'Skill endorsed',
};

async function bootstrap() {
  logger.info('Starting ReachPilot background worker fleet...');

  const app = await NestFactory.createApplicationContext(AppModule);
  const env = getEnv();

  const linkedinDriver = app.get<LinkedInDriver>(LINKEDIN_DRIVER);
  const emailDriver = app.get<EmailDriver>(EMAIL_DRIVER);
  const sessions = app.get(LinkedInSessionService);
  const secrets = app.get(SecretsService);
  const pacing = app.get(PacingService);
  const gmailInbox = app.get(GmailInboxService);
  const scheduler = app.get(SchedulerService);
  const campaignRunner = app.get(CampaignRunnerService);
  const linkedinSync = app.get(LinkedInSyncService);
  const emailWarmup = app.get(EmailWarmupService);
  const connectionNote = app.get(ConnectionNoteService);

  logger.info({ linkedin: env.LINKEDIN_DRIVER, email: env.EMAIL_DRIVER }, 'Drivers selected');

  // Safety visibility: real LinkedIn automation with no proxy means every
  // account egresses from this machine's IP — a ban risk if you run more than
  // one account or move off a residential IP. Expandi's core safety layer is a
  // dedicated geo-IP per account; surface loudly when that's absent.
  if (env.LINKEDIN_DRIVER === 'playwright' && !env.PROXY_SERVER) {
    logger.warn(
      'LINKEDIN_DRIVER=playwright but PROXY_SERVER is empty — real automation will egress from this machine\'s local IP (no dedicated per-account proxy). OK for a single test account; risky for production.',
    );
  }

  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  /* ---------- shared helpers ---------- */

  const advanceEnrollment = async (
    db: any,
    enrollmentId: string | null,
    stepId: string | null,
  ) => {
    if (!enrollmentId || !stepId) return;
    const step = await db
      .selectFrom('campaign_steps')
      .select('next_step_id')
      .where('id', '=', stepId)
      .executeTakeFirst();
    const nextStepId = step?.next_step_id || null;
    await db
      .updateTable('enrollments')
      .set({
        current_step_id: nextStepId,
        status: nextStepId ? 'active' : 'finished',
        // Reset the step-entry clock so the next step's delay window / condition
        // timeout is measured from now, and clear the wait marker so the campaign
        // runner picks it up on the next tick.
        step_entered_at: nowIso(),
        next_run_at: nextStepId ? nowIso() : null,
        finished_at: nextStepId ? null : nowIso(),
      })
      .where('id', '=', enrollmentId)
      .execute();
  };

  const bumpSendStats = async (
    db: any,
    workspaceId: string,
    linkedinAccountId: string,
    kind: 'invite' | 'email',
  ) => {
    // daily_stats is keyed by linkedin_account_id (uuid) — skip when there's
    // no LinkedIn account (e.g. an email-only workspace). hourly_stats isn't.
    if (linkedinAccountId) {
      await db
        .insertInto('daily_stats')
        .values({
          workspace_id: workspaceId,
          linkedin_account_id: linkedinAccountId,
          day: localDate() as any,
          invites_sent: kind === 'invite' ? 1 : 0,
          emails_sent: kind === 'email' ? 1 : 0,
          accepted: 0,
          replies: 0,
        })
        .onConflict((oc: any) =>
          oc.columns(['workspace_id', 'linkedin_account_id', 'day']).doUpdateSet({
            invites_sent: (eb: any) =>
              eb('daily_stats.invites_sent', '+', kind === 'invite' ? 1 : 0),
            emails_sent: (eb: any) =>
              eb('daily_stats.emails_sent', '+', kind === 'email' ? 1 : 0),
          }),
        )
        .execute();
    }

    await db
      .insertInto('hourly_stats')
      .values({
        workspace_id: workspaceId,
        day: localDate() as any,
        hour: new Date().getHours(),
        sends: 1,
        replies: 0,
      })
      .onConflict((oc: any) =>
        oc.columns(['workspace_id', 'day', 'hour']).doUpdateSet({
          sends: (eb: any) => eb('hourly_stats.sends', '+', 1),
        }),
      )
      .execute();
  };

  /** Pause an entire account (checkpoint / limit) and alert the user. */
  const haltAccount = async (
    db: any,
    workspaceId: string,
    accountId: string | null,
    outcome: string,
    _leadName: string,
  ) => {
    if (accountId) {
      await db
        .updateTable('linkedin_accounts')
        .set({ status: outcome === 'checkpoint' ? 'checkpoint' : 'paused' })
        .where('id', '=', accountId)
        .execute();
    }
    await db
      .insertInto('notifications')
      .values({
        workspace_id: workspaceId,
        kind: outcome === 'checkpoint' ? 'account_checkpoint' : 'account_paused',
        text:
          outcome === 'checkpoint'
            ? 'LinkedIn security checkpoint detected — automation paused. Please verify your account.'
            : 'LinkedIn sending limit reached — account paused until it resets.',
      })
      .execute();
  };

  /* ---------- 1. LinkedIn Actions Worker ---------- */

  // When the desktop agent is offline the job is deferred (not failed) and re-driven
  // by the scheduler after this backoff — short enough to resume within minutes of
  // the agent coming back, long enough to avoid hot-looping while it stays offline.
  const AGENT_OFFLINE_BACKOFF_MS = 3 * 60 * 1000;
  // Same idea for a page that never loaded, but a slower beat: a bad link tends
  // to stay bad for a while, and unlike an offline agent there is no heartbeat to
  // tell us it recovered — so back off further rather than re-driving into it.
  const NETWORK_BACKOFF_MS = 10 * 60 * 1000;

  const linkedinWorker = new Worker(
    'linkedin-actions',
    async (job: Job) => {
      const { jobId, workspaceId, leadId, payload } = job.data;
      logger.info({ jobId, leadId }, 'Processing LinkedIn job');
      const jobRow = await withWorkspace(workspaceId, (db) =>
        db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirst(),
      );
      // Skip if gone, canceled, or already sent (idempotent on retry).
      if (!jobRow || jobRow.status === 'canceled' || jobRow.status === 'sent') {
        logger.warn({ jobId }, 'Job already canceled/sent or missing');
        return;
      }

      const accountId = jobRow.linkedin_account_id || '';

      // Pacing / caps / working hours. If blocked, reschedule and return CLEANLY
      // — the scheduler tick is the retry path now. Throwing here would burn all
      // three BullMQ attempts inside the same blocked window and lose the job.
      const isInvite = jobRow.action === 'connect_request';
      const paceResult = await pacing.checkPacingAndRegister(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id);
      if (!paceResult.allowed) {
        const nextRun = paceResult.nextScheduledAt || new Date(Date.now() + 3600000).toISOString();
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: nextRun }).where('id', '=', jobId).execute();
          if (jobRow.enrollment_id) {
            await db.updateTable('enrollments').set({ next_run_at: nextRun, status: 'waiting' }).where('id', '=', jobRow.enrollment_id).execute();
          }
        });
        logger.info({ jobId, nextRun }, 'Pacing limit hit — deferred to scheduler');
        return;
      }

      // Human jitter (outside any transaction).
      const jitterMs = pacing.getRandomJitterMs();
      logger.info({ jobId, jitterMs }, 'Applying jitter before execution');
      await new Promise((r) => setTimeout(r, jitterMs));

      await withWorkspace(workspaceId, (db) =>
        db.updateTable('jobs').set({ status: 'running' }).where('id', '=', jobId).execute(),
      );

      // Build the per-account session (cookie + proxy + fingerprint). Returns
      // null when the account is unusable (checkpoint/paused/disconnected) — in
      // that case hold the job for the scheduler rather than failing it, so it
      // resumes automatically once the account recovers. Don't count the pacing
      // slot we just registered against a send that never happened.
      const ctx = await sessions.buildActionContext(accountId, workspaceId);
      if (accountId && !ctx) {
        await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        const retryAt = new Date(Date.now() + 3600000).toISOString();
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: retryAt, last_error: 'account_unavailable' }).where('id', '=', jobId).execute();
          if (jobRow.enrollment_id) {
            await db.updateTable('enrollments').set({ next_run_at: retryAt, status: 'waiting' }).where('id', '=', jobRow.enrollment_id).execute();
          }
        });
        logger.info({ jobId, accountId }, 'Account not sendable — deferred to scheduler');
        return;
      }

      // Dispatch to the driver method for THIS action. Previously this was a
      // binary connect/message branch, so inmail/follow/like/visit/endorse jobs
      // silently ran as connection requests.
      const drv = ctx || undefined;
      const t = payload.target;
      // Resolve the connection note at SEND time so AI/Apify personalization runs
      // per prospect on the pacing schedule (falls back to the filled template).
      const connectNote =
        jobRow.action === 'connect_request'
          ? await connectionNote.build(workspaceId, payload)
          : payload.message;
      let res: LinkedInActionResult;
      try {
        switch (jobRow.action) {
          case 'linkedin_message':
            res = await linkedinDriver.sendMessage(t, payload.message, drv);
            break;
          case 'inmail':
            res = await linkedinDriver.sendInMail(t, payload.subject || '', payload.message, drv);
            break;
          case 'follow':
            res = await linkedinDriver.follow(t, drv);
            break;
          case 'visit_profile':
            res = await linkedinDriver.visitProfile(t, drv);
            break;
          case 'like_post':
            res = await linkedinDriver.likeRecentPost(t, drv);
            break;
          case 'endorse_skill':
            res = await linkedinDriver.endorseSkill(t, drv);
            break;
          case 'connect_request':
            // Connect WITH the note, auto-falling back to a note-less connect when
            // the account's personalized-note quota is spent (free-tier limit).
            res = await connectWithNoteFallback(linkedinDriver, t, connectNote, drv, logger);
            break;
          default:
            logger.warn({ jobId, action: jobRow.action }, 'Unknown LinkedIn action — treating as connect');
            res = await connectWithNoteFallback(linkedinDriver, t, connectNote, drv, logger);
        }
      } catch (err: any) {
        res = { status: 'failed', error: String(err?.message || err) };
      }

      logger.info({ jobId, outcome: res.status }, 'LinkedIn action outcome');

      // Record the residential IP the desktop agent ran this action from — a
      // rolling "last seen from" per account (also surfaces the split-brain case
      // where the same account runs from two different IPs). Best-effort only.
      if (res.reportedIp) {
        await withWorkspace(workspaceId, (db) =>
          db.updateTable('linkedin_accounts')
            .set({ last_ip: res.reportedIp, last_ip_at: nowIso() })
            .where('id', '=', accountId)
            .execute(),
        ).catch(() => undefined);
      }

      /* ----- classify the outcome (each block commits before any throw) ----- */

      // Success — commit "sent" first, then best-effort bookkeeping.
      if (res.status === 'sent') {
        // Record the slug LinkedIn served so a later upload recognises this
        // member under either URL form. Merged into payload because the app DB
        // role has no DDL rights — a new column is not available to us.
        const storedPayload = res.resolvedSlug
          ? JSON.stringify({ ...payload, resolvedSlug: res.resolvedSlug })
          : null;
        await withWorkspace(workspaceId, (db) =>
          db.updateTable('jobs').set({ status: 'sent', sent_at: nowIso(), ...(storedPayload ? { payload: storedPayload } : {}) }).where('id', '=', jobId).execute(),
        );
        try {
          await withWorkspace(workspaceId, async (db) => {
            const isConnect = jobRow.action === 'connect_request';
            const label = ACTION_LABEL[jobRow.action] || 'Action completed';
            if (leadId && isConnect) {
              // Only a connection request moves the lead to "invited".
              await db.updateTable('leads').set({ status: 'invited', last_activity: 'Invite sent' }).where('id', '=', leadId).execute();
            } else if (leadId) {
              await db.updateTable('leads').set({ last_activity: label }).where('id', '=', leadId).execute();
            }
            await advanceEnrollment(db, jobRow.enrollment_id, jobRow.step_id);
            await db.insertInto('activity').values({ workspace_id: workspaceId, text: `${label} — ${payload.name}`, tone: 'success' }).execute();
            // Only connection requests consume an "invite" against the caps/stats.
            if (isConnect) await bumpSendStats(db, workspaceId, accountId, 'invite');
          });
        } catch (e: any) {
          logger.warn({ jobId, err: e.message }, 'Post-send bookkeeping failed (action already done)');
        }
        return;
      }

      // Skip — already connected / pending. Advance without counting as a send.
      if (SKIP_OUTCOMES.includes(res.status)) {
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'sent', sent_at: nowIso(), last_error: res.status }).where('id', '=', jobId).execute();
          if (leadId && res.status === 'already_connected') {
            await db.updateTable('leads').set({ status: 'accepted', last_activity: 'Already connected' }).where('id', '=', leadId).execute();
          }
          await advanceEnrollment(db, jobRow.enrollment_id, jobRow.step_id);
          await db.insertInto('activity').values({ workspace_id: workspaceId, text: `${payload.name}: ${res.status.replace('_', ' ')} — skipped`, tone: 'muted' }).execute();
        });
        return;
      }

      // Account-level halt — checkpoint or limit. Pause the whole account.
      if (ACCOUNT_HALT_OUTCOMES.includes(res.status)) {
        await withWorkspace(workspaceId, async (db) => {
          await haltAccount(db, workspaceId, accountId, res.status, payload.name);
          if (res.status === 'limit_reached') {
            const tomorrow = new Date(Date.now() + 86400000).toISOString();
            await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: tomorrow, last_error: 'limit_reached' }).where('id', '=', jobId).execute();
            if (jobRow.enrollment_id) {
              await db.updateTable('enrollments').set({ status: 'waiting', next_run_at: tomorrow }).where('id', '=', jobRow.enrollment_id).execute();
            }
          } else {
            await db.updateTable('jobs').set({ status: 'failed', last_error: 'checkpoint' }).where('id', '=', jobId).execute();
            if (jobRow.enrollment_id) {
              await db.updateTable('enrollments').set({ status: 'paused' }).where('id', '=', jobRow.enrollment_id).execute();
            }
          }
        });
        // Do NOT throw — avoid a retry storm against a paused account.
        return;
      }

      // Desktop agent offline (laptop off/asleep/not polling). This is NOT a real
      // send failure — the account is healthy, the executor is just temporarily
      // gone. Treat it like the pacing / account-unavailable cases: release the
      // slot and DEFER to the scheduler. Never throw (so BullMQ attempts aren't
      // burned) and never mark 'failed' (so the job is never lost), and use a short
      // backoff so it resumes within minutes of the agent returning instead of
      // being bumped a whole window forward.
      // 'agent_unavailable' = the agent never took the job (offline/busy) → nothing
      // was sent. 'agent_result_pending' = the agent DID take it but no result came
      // back before the hard cap (rare — agent died mid-job); the action may have
      // gone out. Both are safe to defer: releasing the pacing slot then re-driving
      // nets to exactly one send (the re-dispatch re-registers it), and on re-run a
      // send that already went out is detected as pending/already-connected and
      // marked sent. Never throw (don't burn BullMQ attempts) or fail (never lose it).
      // BUT: 'agent_result_pending' means the agent may have already clicked
      // Send — for linkedin_message/inmail, sendMessage/sendInMail have no
      // idempotency check (they click Send unconditionally on every run), so
      // blindly redispatching this exact case would DM the recipient twice.
      // connect_request/follow/etc. all detect their own already-done state
      // (Pending/already_connected/etc.) before acting, so redriving THOSE is
      // safe either way. Hold the ambiguous message/inmail case for a human to
      // check LinkedIn instead of auto-resending it.
      const nonIdempotentPending =
        res.error === 'agent_result_pending' &&
        (jobRow.action === 'linkedin_message' || jobRow.action === 'inmail');
      if (nonIdempotentPending) {
        await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        await withWorkspace(workspaceId, async (db) => {
          await db
            .updateTable('jobs')
            .set({ status: 'failed', last_error: 'agent_result_pending_review' })
            .where('id', '=', jobId)
            .execute();
          if (jobRow.enrollment_id) {
            await db.updateTable('enrollments').set({ status: 'failed' }).where('id', '=', jobRow.enrollment_id).execute();
          }
          await db
            .insertInto('notifications')
            .values({
              workspace_id: workspaceId,
              kind: 'job_failed',
              text: `${payload.name}: the desktop agent disconnected before confirming this ${jobRow.action === 'inmail' ? 'InMail' : 'message'} sent — check LinkedIn before retrying, to avoid sending it twice.`,
            })
            .execute();
        });
        logger.warn(
          { jobId, accountId, action: jobRow.action },
          'Agent accepted a non-idempotent action but never confirmed the result — held for manual review, not auto-resent',
        );
        return;
      }

      if (res.error === 'agent_unavailable' || res.error === 'agent_result_pending') {
        await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        const retryAt = new Date(Date.now() + AGENT_OFFLINE_BACKOFF_MS).toISOString();
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: retryAt, last_error: res.error }).where('id', '=', jobId).execute();
          if (jobRow.enrollment_id) {
            await db.updateTable('enrollments').set({ status: 'waiting', next_run_at: retryAt }).where('id', '=', jobRow.enrollment_id).execute();
          }
        });
        logger.info({ jobId, accountId, retryAt, reason: res.error }, 'Desktop agent did not return a result — deferred to scheduler');
        return;
      }

      // The profile page never loaded on the user's own link. Same shape as the
      // agent-offline case: the account is fine, the lead is fine, the CONNECTION
      // was down. The driver only reports this from an action's FIRST navigation,
      // so nothing was clicked and nothing was sent — safe to re-drive. Defer;
      // never mark 'failed' (which would surface a healthy lead as dead in the UI)
      // and never throw (which would burn the BullMQ attempts on a bad-network
      // window and lose the job for good).
      if (DEFER_OUTCOMES.includes(res.status)) {
        await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        const retryAt = new Date(Date.now() + NETWORK_BACKOFF_MS).toISOString();
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: retryAt, last_error: res.error || res.status }).where('id', '=', jobId).execute();
          if (jobRow.enrollment_id) {
            await db.updateTable('enrollments').set({ status: 'waiting', next_run_at: retryAt }).where('id', '=', jobRow.enrollment_id).execute();
          }
        });
        logger.warn({ jobId, accountId, retryAt, reason: res.error }, 'Page never loaded (network) — deferred to scheduler, lead NOT failed');
        return;
      }

      // Terminal per-lead failures — mark failed, no retry. No invite left our
      // account, so give the pacing slot back.
      if (TERMINAL_FAIL_OUTCOMES.includes(res.status)) {
        await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        // Prefer the driver's specific reason (e.g. 'email_required') over the
        // coarse outcome name, so the UI explains WHY a lead was skipped.
        const reason = res.error || res.status;
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'failed', last_error: reason }).where('id', '=', jobId).execute();
          if (leadId && res.status === 'profile_gone') {
            await db.updateTable('leads').set({ status: 'unqualified', last_activity: 'Profile unavailable' }).where('id', '=', leadId).execute();
          }
          if (jobRow.enrollment_id) {
            await db.updateTable('enrollments').set({ status: 'failed' }).where('id', '=', jobRow.enrollment_id).execute();
          }
          await db.insertInto('notifications').values({ workspace_id: workspaceId, kind: 'job_failed', text: `Outreach to ${payload.name} skipped: ${reason.replace(/_/g, ' ')}` }).execute();
        });
        return;
      }

      // Generic transient failure — release the slot (the retry will re-register
      // it) then mark failed and throw so BullMQ retries with backoff.
      await pacing.release(accountId, 'linkedin', workspaceId, isInvite).catch(() => undefined);
      await withWorkspace(workspaceId, async (db) => {
        await db.updateTable('jobs').set({ status: 'failed', last_error: res.error || 'failed' }).where('id', '=', jobId).execute();
        if (jobRow.enrollment_id) {
          await db.updateTable('enrollments').set({ status: 'failed' }).where('id', '=', jobRow.enrollment_id).execute();
        }
        await db.insertInto('notifications').values({ workspace_id: workspaceId, kind: 'job_failed', text: `Outreach to ${payload.name} failed: ${res.error || 'unknown error'}` }).execute();
      });
      throw new Error(res.error || 'LinkedIn driver failed');
    },
    // concurrency 3: different tenants' jobs run in parallel (remote dispatch just
    // awaits each account's desktop agent; the agent still serialises its own
    // account's jobs). Bump higher as accounts scale.
    { connection: connection as any, concurrency: 3 },
  );

  /* ---------- 2. LinkedIn Login Worker (cookie capture) ---------- */

  // How long to wait between retries while the desktop agent hasn't polled yet
  // (laptop off, app not opened post-onboarding), and how many times to try
  // before giving up and telling the user to reconnect. ~1 hour total.
  const LOGIN_AGENT_WAIT_BACKOFF_MS = 3 * 60 * 1000;
  const LOGIN_AGENT_WAIT_MAX_ATTEMPTS = 20;

  const loginWorker = new Worker(
    'linkedin-login',
    async (job: Job) => {
      const { accountId, workspaceId, agentWaitAttempt } = job.data as {
        accountId: string;
        workspaceId: string;
        agentWaitAttempt?: number;
      };
      logger.info({ accountId }, 'Processing LinkedIn login');

      const loginCtx = await sessions.buildLoginContext(accountId, workspaceId);
      if (!loginCtx) {
        logger.warn({ accountId }, 'No login context (missing credentials)');
        return;
      }

      const res = await linkedinDriver.login(loginCtx);
      logger.info({ accountId, status: res.status, reportedIp: res.reportedIp }, 'Login outcome');

      // The desktop agent reports the residential IP it actually ran from. Record
      // it on every outcome (last_ip) so we can see which IP even a FAILED login
      // came from; login_ip is stamped only on a real successful login.
      const ipSet: Record<string, string> = res.reportedIp
        ? { last_ip: res.reportedIp, last_ip_at: nowIso() }
        : {};

      if (res.status === 'connected' && res.li_at) {
        // Store the captured session encrypted. Prefer the WHOLE jar: `li_at`
        // alone cannot restore a session on a fresh profile (it redirect-loops
        // without JSESSIONID/bcookie/liap), so storing only that left us with a
        // "backup" that could never actually bring an account back.
        const sessionSecretId = await secrets.encrypt(
          res.cookies?.length ? serializeSession(res.cookies) : res.li_at,
          'linkedin_session',
          { workspaceId },
        );
        await withWorkspace(workspaceId, async (db) => {
          await db
            .updateTable('linkedin_accounts')
            .set({
              session_secret_id: sessionSecretId,
              status: 'warming_up',
              last_sync_at: nowIso(),
              ...(res.reportedIp ? { login_ip: res.reportedIp } : {}),
              ...ipSet,
            })
            .where('id', '=', accountId)
            .execute();
          await db.insertInto('activity').values({ workspace_id: workspaceId, text: 'LinkedIn account connected — session secured', tone: 'success' }).execute();
          await db.insertInto('notifications').values({ workspace_id: workspaceId, kind: 'account_connected', text: 'Your LinkedIn account is connected and warming up.' }).execute();
        });
        return;
      }

      if (res.status === 'checkpoint') {
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('linkedin_accounts').set({ status: 'checkpoint', ...ipSet }).where('id', '=', accountId).execute();
          await db.insertInto('notifications').values({ workspace_id: workspaceId, kind: 'account_checkpoint', text: 'LinkedIn asked for extra verification during login. Please complete it to finish connecting.' }).execute();
        });
        return;
      }

      // Desktop agent hasn't polled yet (user hasn't opened the app post-onboarding,
      // or their laptop is off) — no LinkedIn login was even attempted, so this is
      // NOT a real failure. Marking 'disconnected' here (as the code used to) left
      // a user who finishes onboarding before opening the desktop app stuck: no
      // LinkedIn login attempt was made, but the 6h enqueueLogin cooldown then
      // blocked a fresh one, and BullMQ's own retry (attempts: 2, ~10s backoff) is
      // far too short for "hasn't opened the app yet". Re-add a delayed job
      // instead (bypasses that cooldown, which only guards NEW enqueues) and only
      // give up — marking disconnected for a real reconnect — after ~1 hour.
      if (res.error === 'agent_unavailable' || res.error === 'agent_result_pending') {
        const attempt = (agentWaitAttempt || 0) + 1;
        if (attempt <= LOGIN_AGENT_WAIT_MAX_ATTEMPTS) {
          await getLoginQueue().add(
            'login',
            { accountId, workspaceId, agentWaitAttempt: attempt },
            { delay: LOGIN_AGENT_WAIT_BACKOFF_MS, attempts: 1, removeOnComplete: true },
          );
          logger.info({ accountId, attempt }, 'Desktop agent not online yet for login — deferred, will retry');
          return;
        }
        logger.warn({ accountId }, 'Desktop agent never came online for login — giving up');
      }

      // Failed — bad credentials, unreachable, or the agent never showed up.
      await withWorkspace(workspaceId, async (db) => {
        await db.updateTable('linkedin_accounts').set({ status: 'disconnected', ...ipSet }).where('id', '=', accountId).execute();
        await db.insertInto('notifications').values({ workspace_id: workspaceId, kind: 'account_failed', text: `Could not connect LinkedIn: ${res.error || 'login failed'}. Please reconnect.` }).execute();
      });
    },
    { connection: connection as any, concurrency: 2 },
  );

  /* ---------- 3. Email Actions Worker ---------- */

  const emailWorker = new Worker(
    'email-send',
    async (job: Job) => {
      const { jobId, workspaceId, leadId, payload } = job.data;
      logger.info({ jobId, leadId }, 'Processing Email job');

      // Each DB block runs under the workspace's RLS context and commits before
      // any throw (so status writes aren't rolled back on failure).
      const jobRow = await withWorkspace(workspaceId, (db) =>
        db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirst(),
      );
      // Skip if gone, canceled, or already sent (idempotent on retry — never double-send).
      if (!jobRow || jobRow.status === 'canceled' || jobRow.status === 'sent') return;

      const paceResult = await pacing.checkPacingAndRegister(
        jobRow.email_account_id || '',
        'email',
        workspaceId,
        true,
        jobRow.campaign_id,
      );
      if (!paceResult.allowed) {
        const nextRun = paceResult.nextScheduledAt || new Date(Date.now() + 3600000).toISOString();
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: nextRun }).where('id', '=', jobId).execute();
          if (jobRow.enrollment_id) {
            await db.updateTable('enrollments').set({ next_run_at: nextRun, status: 'waiting' }).where('id', '=', jobRow.enrollment_id).execute();
          }
        });
        logger.info({ jobId, nextRun }, 'Email pacing limit hit — deferred to scheduler');
        return;
      }

      await withWorkspace(workspaceId, (db) =>
        db.updateTable('jobs').set({ status: 'running' }).where('id', '=', jobId).execute(),
      );

      let res: { status: 'sent' | 'failed'; externalId?: string; error?: string };
      try {
        res = await emailDriver.sendEmail(payload.target, payload.subject, payload.message, {
          emailAccountId: jobRow.email_account_id || undefined,
          workspaceId,
        });
      } catch (err: any) {
        res = { status: 'failed', error: String(err?.message || err) };
      }
      logger.info({ jobId, outcome: res.status }, 'Email action outcome');

      if (res.status === 'sent') {
        // Commit "sent" FIRST in its own transaction — so if any ancillary
        // write below fails, the idempotency guard prevents a re-send on retry.
        await withWorkspace(workspaceId, (db) =>
          db.updateTable('jobs').set({ status: 'sent', sent_at: nowIso() }).where('id', '=', jobId).execute(),
        );
        // Ancillary bookkeeping — best-effort, never causes a re-send.
        try {
          await withWorkspace(workspaceId, async (db) => {
            if (leadId) {
              await db.updateTable('leads').set({ status: 'invited', last_activity: 'Email sent' }).where('id', '=', leadId).execute();
            }
            await advanceEnrollment(db, jobRow.enrollment_id, jobRow.step_id);
            await db.insertInto('activity').values({ workspace_id: workspaceId, text: `Email sent to ${payload.name}`, tone: 'success' }).execute();
            await bumpSendStats(db, workspaceId, jobRow.linkedin_account_id || '', 'email');
          });
        } catch (e: any) {
          logger.warn({ jobId, err: e.message }, 'Post-send bookkeeping failed (email already sent)');
        }
        return;
      }

      // Failed — record and throw so BullMQ retries with backoff.
      logger.error({ jobId, err: res.error }, 'Email job failed');
      await withWorkspace(workspaceId, async (db) => {
        await db.updateTable('jobs').set({ status: 'failed', last_error: res.error || 'failed' }).where('id', '=', jobId).execute();
        if (jobRow.enrollment_id) {
          await db.updateTable('enrollments').set({ status: 'failed' }).where('id', '=', jobRow.enrollment_id).execute();
        }
        await db.insertInto('notifications').values({ workspace_id: workspaceId, kind: 'job_failed', text: `Email to ${payload.name} failed: ${res.error || 'unknown error'}` }).execute();
      });
      throw new Error(res.error || 'Email driver failed');
    },
    { connection: connection as any, concurrency: 5 },
  );

  /* ---------- lifecycle logging ---------- */

  linkedinWorker.on('completed', (job) => logger.info({ jobId: job.id }, 'LinkedIn job completed'));
  linkedinWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'LinkedIn job failed'));
  loginWorker.on('completed', (job) => logger.info({ jobId: job.id }, 'Login job completed'));
  loginWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'Login job failed'));
  emailWorker.on('completed', (job) => logger.info({ jobId: job.id }, 'Email job completed'));
  emailWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'Email job failed'));

  /* ---------- 4. Gmail inbox sync (reply detection) ---------- */

  // Poll connected mailboxes for replies → auto-pause sequence + inbox thread.
  const INBOX_SYNC_MS = 3 * 60 * 1000;
  const runInboxSync = async () => {
    try {
      await gmailInbox.syncAll();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Gmail inbox sync tick failed');
    }
  };
  if (env.GMAIL_SYNC_ENABLED) {
    setTimeout(runInboxSync, 30_000); // first pass shortly after boot
    setInterval(runInboxSync, INBOX_SYNC_MS);
  } else {
    logger.warn('Gmail inbox sync DISABLED (GMAIL_SYNC_ENABLED=false) — email replies will not be detected.');
  }

  /* ---------- 5. Scheduler: drain due `scheduled` jobs into the queues ---------- */

  // This is what makes multi-day sequences actually advance. Every tick it finds
  // jobs whose `scheduled_for` has passed, gates them (account health +
  // suppression), and enqueues them. Without it, only day-one sends ever fire.
  const runSchedulerTick = async () => {
    try {
      await scheduler.tick();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Scheduler tick failed');
    }
  };
  if (env.SCHEDULER_ENABLED) {
    setTimeout(runSchedulerTick, 5_000); // first drain shortly after boot
    setInterval(runSchedulerTick, env.SCHEDULER_TICK_MS);
  } else {
    logger.warn(
      'Scheduler DISABLED (SCHEDULER_ENABLED=false) — `scheduled` jobs (multi-day steps, pacing-deferred retries) will NOT advance. Immediate day-0 sends still run.',
    );
  }

  /* ---------- 5b. Campaign runner: drive enrollments through the sequence ---------- */

  // The heartbeat of the campaign engine. Every tick it finds enrollments that
  // are ready to move (active, or waiting with the wait window elapsed) in an
  // active campaign and runs the current step via the graph executor — creating
  // the next durable job, evaluating conditions, or finishing the lead. The
  // scheduler (5) then dispatches the jobs it creates. Without this, a campaign
  // never advances past the step the enroll call kicked off.
  const runCampaignTick = async () => {
    try {
      await campaignRunner.tick();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Campaign runner tick failed');
    }
  };
  if (env.CAMPAIGN_RUNNER_ENABLED) {
    setTimeout(runCampaignTick, 8_000); // first pass shortly after boot
    setInterval(runCampaignTick, env.CAMPAIGN_RUNNER_TICK_MS);
  } else {
    logger.warn(
      'Campaign runner DISABLED (CAMPAIGN_RUNNER_ENABLED=false) — campaign enrollments will NOT advance through their sequence.',
    );
  }

  /* ---------- 6. LinkedIn sync: acceptance + reply detection (B4) ---------- */

  // The LinkedIn counterpart to the Gmail inbox sync, extracted into
  // LinkedInSyncService so its apply-logic is independently testable. For every
  // sendable account it reads recent connections + unread messages via the
  // driver (read-only), applies invited→accepted / accepted→replied (+ inbox
  // thread, auto-pause), and withdraws stale pending invites.
  const runLinkedInSync = async () => {
    try {
      await linkedinSync.syncAll();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'LinkedIn sync tick failed');
    }
  };
  if (env.LINKEDIN_SYNC_ENABLED) {
    setTimeout(runLinkedInSync, 45_000); // first pass a bit after boot
    setInterval(runLinkedInSync, env.LINKEDIN_SYNC_TICK_MS);
  } else {
    logger.warn(
      'LinkedIn sync DISABLED (LINKEDIN_SYNC_ENABLED=false) — no browser will open on a timer, but accepted invites / replies will NOT be detected and stale invites will NOT be withdrawn.',
    );
  }

  /* ---------- 7. Email warm-up loop (deliverability) ---------- */

  // The workspace's own Gmail mailboxes exchange natural mails and engage with
  // them (read / star / reply / rescue-from-spam) so Gmail learns each sender
  // gets engagement. API only — opens no browser. Needs ≥2 connected mailboxes.
  const runEmailWarmup = async () => {
    try {
      await emailWarmup.tick();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Email warm-up tick failed');
    }
  };
  if (env.EMAIL_WARMUP_ENABLED && env.EMAIL_DRIVER === 'gmail') {
    setTimeout(runEmailWarmup, 60_000); // first pass shortly after boot
    setInterval(runEmailWarmup, env.EMAIL_WARMUP_TICK_MS);
  } else {
    logger.warn(
      'Email warm-up DISABLED (EMAIL_WARMUP_ENABLED=false or EMAIL_DRIVER!=gmail) — no mailbox reputation building.',
    );
  }

  /* ---------- 8. Lead scraper (free local Google → LinkedIn) ---------- */

  // A headful stealth (patchright) browser scrapes Google for LinkedIn profiles
  // matching the requested titles + location, then imports them via LeadsService
  // (same dedup path as CSV import). Browser work belongs in the worker; the API
  // only enqueues. NEVER touches a LinkedIn account session — reads Google only.
  const leadScraper = app.get(LeadScraperService);
  const leadsService = app.get(LeadsService);
  const scrapeCursor = app.get(ScrapeCursorService);
  const scrapeJobs = app.get(ScrapeJobsService);
  const leadScrapeWorker = new Worker(
    'lead-scrape',
    async (job: Job) => {
      const { workspaceId, titles, location, maxResults, startFresh, scrapeJobId } = job.data;
      try {
        // Cursor: where did the last run for this exact search stop? Start there so
        // a rerun sweeps NEW pages instead of re-fetching page 1 (import-dedup would
        // otherwise drop it all → "0 new"). A startFresh job re-sweeps from page 0.
        const qk = scrapeCursor.queryKey(titles, location);
        if (startFresh) await scrapeCursor.reset(workspaceId, qk);
        const startPage = startFresh ? 0 : await scrapeCursor.nextPage(workspaceId, qk);
        const pages = Math.min(Math.max(Math.ceil((maxResults || 15) / 8), 1), 10);
        logger.info({ titles, location, maxResults, startPage, pages }, 'Processing lead-scrape job');
        await scrapeJobs.update(workspaceId, scrapeJobId, { status: 'running', stage: 'searching Google' });

        // Offload the browser scrape to the remote service when configured (VPS +
        // Xvfb), else scrape locally in-process. Remote failures fall back to local
        // so a service blip never drops the job.
        let leads: any[];
        const req = { titles, location, maxResults, startPage, pages };
        if (env.SCRAPER_SERVICE_URL) {
          try {
            leads = await scrapeViaService(env.SCRAPER_SERVICE_URL, env.SCRAPER_SERVICE_TOKEN, req);
            logger.info({ count: leads.length }, 'lead-scrape: got leads from scraper service');
          } catch (err: any) {
            logger.warn({ err: err?.message || err }, 'scraper service failed — scraping locally');
            leads = await leadScraper.search(req);
          }
        } else {
          leads = await leadScraper.search(req);
        }

        // Only advance the cursor when the run actually produced leads — a fully
        // blocked/empty run keeps the same page window for the next attempt.
        if (leads.length) await scrapeCursor.advance(workspaceId, qk, pages);

        if (!leads.length) {
          logger.warn({ titles, location, startPage }, 'lead-scrape: no profiles found');
          await scrapeJobs.update(workspaceId, scrapeJobId, {
            status: 'blocked',
            stage: 'done',
            reason: 'no_results',
            counts: { valid: 0, imported: 0 },
          });
          return;
        }

        await scrapeJobs.update(workspaceId, scrapeJobId, {
          stage: 'importing',
          counts: { valid: leads.length },
        });
        const rows = leads.map((l) => ({
          name: l.name,
          role: l.title,
          company: l.company,
          location: l.location,
          linkedinUrl: l.linkedinUrl,
        }));
        const res = await leadsService.importLeads(
          workspaceId,
          `google-scrape:${titles.join('/')}`,
          rows,
          scrapeJobId,
        );
        logger.info({ scraped: leads.length, imported: res.count }, 'lead-scrape: leads imported');
        await scrapeJobs.update(workspaceId, scrapeJobId, {
          status: 'done',
          stage: 'done',
          counts: { valid: leads.length, imported: res.count },
        });
      } catch (err: any) {
        await scrapeJobs.update(workspaceId, scrapeJobId, {
          status: 'failed',
          reason: String(err?.message || err).slice(0, 200),
        });
        throw err;
      }
    },
    { connection: connection as any, concurrency: 1 },
  );
  leadScrapeWorker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, err: err.message }, 'lead-scrape job failed'),
  );

  logger.info(
    { schedulerTickMs: env.SCHEDULER_TICK_MS },
    'Worker fleet ready: linkedin-actions, linkedin-login, email-send, gmail-inbox-sync, scheduler, campaign-runner, linkedin-sync, email-warmup, lead-scrape',
  );
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Worker fleet bootstrap crashed');
  process.exit(1);
});
