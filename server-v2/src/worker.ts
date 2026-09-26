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
  networkDeferExhausted,
  failureText,
  isSignedOutNav,
} from '@/modules/drivers/linkedin-driver.interface';
import { serializeSession } from '@/modules/drivers/linkedin-session-store';
import { EmailDriver } from '@/modules/drivers/email-driver.interface';
import { SecretsService } from '@/modules/vault/secrets.service';
import { PacingService } from '@/modules/engine/pacing.service';
import {
  advanceEnrollment,
  deferEnrollment,
  setLiveEnrollmentStatus,
} from '@/modules/engine/enrollment-state';
import { GmailInboxService } from '@/modules/integrations/gmail-inbox.service';
import { SchedulerService } from '@/modules/engine/scheduler.service';
import { CampaignRunnerService } from '@/modules/engine/campaign-runner.service';
import { LinkedInSyncService } from '@/modules/drivers/linkedin-sync.service';
import { assertTenantIsolation } from '@/db/tenant-isolation';
import { getDb } from '@/db';
import { EmailWarmupService } from '@/modules/drivers/email-warmup.service';
import { LeadScraperService } from '@/modules/scraping/lead-scraper.service';
import { ScrapeCursorService } from '@/modules/scraping/scrape-cursor.service';
import { ScrapeJobsService } from '@/modules/scraping/scrape-jobs.service';
import { LeadsService } from '@/modules/leads/leads.service';
import pino from 'pino';

const logger = pino({ name: 'worker' });

// Stay up through transient DB blips (e.g. the pooler dropping a connection);
// the scheduler re-drives any job they interrupt.
process.on('unhandledRejection', (reason: any) => {
  logger.warn(`Unhandled rejection (non-fatal): ${reason?.message || reason}`);
});
process.on('uncaughtException', (err: any) => {
  logger.error(`Uncaught exception (kept alive): ${err?.message || err}`);
});

const nowIso = () => new Date().toISOString();
const localDate = () => new Date().toLocaleDateString('en-US');

/**
 * Scrape via the standalone scraper service when SCRAPER_SERVICE_URL is set.
 * Throws on any failure so the caller can scrape locally instead.
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

  // Same gate as the API: the scheduler tick drains every workspace.
  await assertTenantIsolation(getDb());
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

  // Real automation with no proxy egresses every account from this machine's IP.
  if (env.LINKEDIN_DRIVER === 'playwright' && !env.PROXY_SERVER) {
    logger.warn(
      'LINKEDIN_DRIVER=playwright but PROXY_SERVER is empty — real automation will egress from this machine\'s local IP (no dedicated per-account proxy). OK for a single test account; risky for production.',
    );
  }

  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  /* ---------- shared helpers ---------- */

  const bumpSendStats = async (
    db: any,
    workspaceId: string,
    linkedinAccountId: string,
    kind: 'invite' | 'email',
  ) => {
    // daily_stats is keyed by LinkedIn account; skip it for email-only workspaces.
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
        .set({
          status:
            outcome === 'checkpoint'
              ? 'checkpoint'
              : outcome === 'session_expired'
                ? 'disconnected'
                : 'paused',
        })
        .where('id', '=', accountId)
        .execute();
    }
    await db
      .insertInto('notifications')
      .values({
        workspace_id: workspaceId,
        kind:
          outcome === 'checkpoint'
            ? 'account_checkpoint'
            : outcome === 'session_expired'
              ? 'account_disconnected'
              : 'account_paused',
        text:
          outcome === 'checkpoint'
            ? 'LinkedIn security checkpoint detected — automation paused. Please verify your account.'
            : outcome === 'session_expired'
              ? 'LinkedIn signed this account out, so nothing is being sent. Reconnect it and the queued outreach resumes on its own — no leads were lost.'
              : 'LinkedIn sending limit reached — account paused until it resets.',
      })
      .execute();
  };

  /* ---------- 1. LinkedIn Actions Worker ---------- */

  // Agent offline: defer (not fail); short enough to resume soon after it returns.
  const AGENT_OFFLINE_BACKOFF_MS = 3 * 60 * 1000;
  // Page never loaded: back off longer; a bad link tends to stay bad.
  const NETWORK_BACKOFF_MS = 10 * 60 * 1000;
  // Signed out: only a human reconnect fixes it (the account is halted anyway).
  const SESSION_EXPIRED_BACKOFF_MS = 60 * 60 * 1000;

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

      // Pacing / caps / working hours: if blocked, reschedule and RETURN. Throwing
      // would burn all BullMQ attempts inside the blocked window and lose the job.
      const isInvite = jobRow.action === 'connect_request';
      const paceResult = await pacing.checkPacingAndRegister(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id);
      if (!paceResult.allowed) {
        const nextRun = paceResult.nextScheduledAt || new Date(Date.now() + 3600000).toISOString();
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: nextRun }).where('id', '=', jobId).execute();
          await deferEnrollment(db, workspaceId, jobRow.enrollment_id, nextRun);
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

      // Null when the account is unusable (checkpoint/paused/disconnected): hold the
      // job for the scheduler and give back the pacing slot.
      const ctx = await sessions.buildActionContext(accountId, workspaceId);
      if (accountId && !ctx) {
        await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        const retryAt = new Date(Date.now() + 3600000).toISOString();
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: retryAt, last_error: 'account_unavailable' }).where('id', '=', jobId).execute();
          await deferEnrollment(db, workspaceId, jobRow.enrollment_id, retryAt);
        });
        logger.info({ jobId, accountId }, 'Account not sendable — deferred to scheduler');
        return;
      }

      // Dispatch to the driver method for this action type.
      const drv = ctx || undefined;
      const t = payload.target;
      // Resolve the note at send time so personalisation runs per prospect.
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
            // Falls back to a note-less connect when the note quota is spent.
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

      // Record the IP the desktop agent ran from (best-effort).
      if (res.reportedIp) {
        await withWorkspace(workspaceId, (db) =>
          db.updateTable('linkedin_accounts')
            .set({ last_ip: res.reportedIp, last_ip_at: nowIso() })
            .where('id', '=', accountId)
            .execute(),
        ).catch(() => undefined);
      }

      /* ----- classify the outcome (each block commits before any throw) ----- */

      // 🔴 Classify a signed-out account first. Older desktop agents report the
      // redirect loop as a generic failure; catching it server-side fixes every app
      // version without a reinstall.
      if (res.status === 'failed' && isSignedOutNav('', res.error || '')) {
        logger.warn(
          { jobId, accountId, error: res.error },
          'Agent reported a signed-out redirect loop — re-classifying as session_expired',
        );
        res = { ...res, status: 'session_expired' };
      }

      // Success — commit "sent" first, then best-effort bookkeeping.
      if (res.status === 'sent') {
        // Store the slug LinkedIn served so either URL form matches later. Kept in
        // payload because the app DB role has no DDL rights.
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
            await advanceEnrollment(db, workspaceId, jobRow.enrollment_id, jobRow.step_id);
            await db.insertInto('activity').values({ workspace_id: workspaceId, text: `${label} — ${payload.name}`, tone: 'success' }).execute();
            // Only connection requests consume an "invite" against the caps/stats.
            if (isConnect) await bumpSendStats(db, workspaceId, accountId, 'invite');
          });
        } catch (e: any) {
          logger.warn({ jobId, err: e.message }, 'Post-send bookkeeping failed (action already done)');
        }
        return;
      }

      // Already connected / pending: advance without counting as a send, and give
      // the pacing slot back.
      if (SKIP_OUTCOMES.includes(res.status)) {
        await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'sent', sent_at: nowIso(), last_error: res.status }).where('id', '=', jobId).execute();
          if (leadId && res.status === 'already_connected') {
            await db.updateTable('leads').set({ status: 'accepted', last_activity: 'Already connected' }).where('id', '=', leadId).execute();
          }
          await advanceEnrollment(db, workspaceId, jobRow.enrollment_id, jobRow.step_id);
          await db.insertInto('activity').values({ workspace_id: workspaceId, text: `${payload.name}: ${res.status.replace('_', ' ')} — skipped`, tone: 'muted' }).execute();
        });
        return;
      }

      // Account-level halt — checkpoint or limit. Pause the whole account.
      if (ACCOUNT_HALT_OUTCOMES.includes(res.status)) {
        // Signed out clicked nothing, so return the slot. (`limit_reached` keeps it:
        // LinkedIn itself said stop.)
        if (res.status === 'session_expired') {
          await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        }
        await withWorkspace(workspaceId, async (db) => {
          await haltAccount(db, workspaceId, accountId, res.status, payload.name);
          // Nothing was sent, so the lead is untouched: hold the job until the account
          // is healthy.
          if (res.status === 'limit_reached' || res.status === 'session_expired') {
            const retryAt = new Date(
              Date.now() + (res.status === 'limit_reached' ? 86400000 : SESSION_EXPIRED_BACKOFF_MS),
            ).toISOString();
            await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: retryAt, last_error: res.status }).where('id', '=', jobId).execute();
            await deferEnrollment(db, workspaceId, jobRow.enrollment_id, retryAt);
          } else {
            await db.updateTable('jobs').set({ status: 'failed', last_error: 'checkpoint' }).where('id', '=', jobId).execute();
            await setLiveEnrollmentStatus(db, workspaceId, jobRow.enrollment_id, 'paused');
          }
        });
        // Do NOT throw — avoid a retry storm against a paused account.
        return;
      }

      // Agent offline or no result: nothing failed, so release the slot and defer to
      // the scheduler (never throw, never mark failed). 'agent_result_pending' may
      // have sent: a re-run of connect/follow detects its own done state, but
      // message/InMail would send twice, so hold those for a human.
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
          await setLiveEnrollmentStatus(db, workspaceId, jobRow.enrollment_id, 'failed');
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
          await deferEnrollment(db, workspaceId, jobRow.enrollment_id, retryAt);
        });
        logger.info({ jobId, accountId, retryAt, reason: res.error }, 'Desktop agent did not return a result — deferred to scheduler');
        return;
      }

      // Page never loaded: the account and lead are fine. Emitted only from an
      // action's first navigation, so nothing was sent; defer, never fail or throw.
      if (DEFER_OUTCOMES.includes(res.status)) {
        await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        const tries = (jobRow.attempts ?? 0) + 1;

        // Bound the deferral: a dead link looks like a slow page, so after a generous
        // budget tell the user the link is bad.
        if (networkDeferExhausted(jobRow.attempts)) {
          await withWorkspace(workspaceId, async (db) => {
            await db
              .updateTable('jobs')
              .set({ status: 'failed', attempts: tries, last_error: 'profile_unreachable' })
              .where('id', '=', jobId)
              .execute();
            await setLiveEnrollmentStatus(db, workspaceId, jobRow.enrollment_id, 'failed');
            await db
              .insertInto('notifications')
              .values({
                workspace_id: workspaceId,
                kind: 'job_failed',
                text: `Outreach to ${payload.name} stopped: ${failureText('profile_unreachable')}`,
              })
              .execute();
          });
          logger.warn(
            { jobId, accountId, attempts: tries, reason: res.error },
            'Page never loaded after the full retry budget — treating the link as dead instead of retrying it forever',
          );
          return;
        }

        const retryAt = new Date(Date.now() + NETWORK_BACKOFF_MS).toISOString();
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'scheduled', scheduled_for: retryAt, attempts: tries, last_error: res.error || res.status }).where('id', '=', jobId).execute();
          await deferEnrollment(db, workspaceId, jobRow.enrollment_id, retryAt);
        });
        logger.warn({ jobId, accountId, retryAt, attempts: tries, reason: res.error }, 'Page never loaded (network) — deferred to scheduler, lead NOT failed');
        return;
      }

      // Terminal per-lead failure: mark failed, no retry, give the slot back.
      if (TERMINAL_FAIL_OUTCOMES.includes(res.status)) {
        await pacing.release(accountId, 'linkedin', workspaceId, isInvite, jobRow.campaign_id).catch(() => undefined);
        // Prefer the driver's specific reason so the UI can explain the skip.
        const reason = res.error || res.status;
        await withWorkspace(workspaceId, async (db) => {
          await db.updateTable('jobs').set({ status: 'failed', last_error: reason }).where('id', '=', jobId).execute();
          if (leadId && res.status === 'profile_gone') {
            await db.updateTable('leads').set({ status: 'unqualified', last_activity: 'Profile unavailable' }).where('id', '=', leadId).execute();
          }
          await setLiveEnrollmentStatus(db, workspaceId, jobRow.enrollment_id, 'failed');
          await db.insertInto('notifications').values({ workspace_id: workspaceId, kind: 'job_failed', text: `Outreach to ${payload.name} skipped: ${failureText(reason)}` }).execute();
        });
        return;
      }

      // Transient failure: release the slot (the retry re-registers it), then throw
      // so BullMQ retries with backoff.
      await pacing.release(accountId, 'linkedin', workspaceId, isInvite).catch(() => undefined);
      await withWorkspace(workspaceId, async (db) => {
        await db.updateTable('jobs').set({ status: 'failed', last_error: res.error || 'failed' }).where('id', '=', jobId).execute();
        await setLiveEnrollmentStatus(db, workspaceId, jobRow.enrollment_id, 'failed');
        await db.insertInto('notifications').values({ workspace_id: workspaceId, kind: 'job_failed', text: `Outreach to ${payload.name} failed: ${failureText(res.error)}` }).execute();
      });
      throw new Error(res.error || 'LinkedIn driver failed');
    },
    // Different tenants run in parallel; each desktop agent serialises its account.
    { connection: connection as any, concurrency: 3 },
  );

  /* ---------- 2. LinkedIn Login Worker (cookie capture) ---------- */

  // Wait for a desktop agent that hasn't polled yet; give up after ~1 hour.
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

      // Record the agent's IP on every outcome; login_ip only on success.
      const ipSet: Record<string, string> = res.reportedIp
        ? { last_ip: res.reportedIp, last_ip_at: nowIso() }
        : {};

      if (res.status === 'connected' && res.li_at) {
        // Store the whole cookie jar: li_at alone can't restore a session.
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

      // The agent hasn't polled yet, so no login was attempted. Re-add a delayed job
      // (BullMQ's short retry and the 6h enqueue cooldown don't fit "app not opened
      // yet"); mark disconnected only after ~1 hour.
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

      // Each DB block commits before any throw so status writes survive a failure.
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
          await deferEnrollment(db, workspaceId, jobRow.enrollment_id, nextRun);
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
        // Commit "sent" first so a failing ancillary write can't cause a re-send.
        await withWorkspace(workspaceId, (db) =>
          db.updateTable('jobs').set({ status: 'sent', sent_at: nowIso() }).where('id', '=', jobId).execute(),
        );
        // Ancillary bookkeeping — best-effort, never causes a re-send.
        try {
          await withWorkspace(workspaceId, async (db) => {
            if (leadId) {
              await db.updateTable('leads').set({ status: 'invited', last_activity: 'Email sent' }).where('id', '=', leadId).execute();
            }
            await advanceEnrollment(db, workspaceId, jobRow.enrollment_id, jobRow.step_id);
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
        await setLiveEnrollmentStatus(db, workspaceId, jobRow.enrollment_id, 'failed');
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

  // Drain due `scheduled` jobs; without this only day-one sends fire.
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

  // Move ready enrollments through their sequence via the graph executor; the
  // scheduler then dispatches the jobs it creates.
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

  // Per sendable account: detect acceptances and replies, withdraw stale invites.
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

  // Mailboxes in the workspace mail and engage with each other to build sender
  // reputation. API only; needs at least two connected mailboxes.
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

  // Scrape Google for LinkedIn profiles and import them. Never touches a
  // LinkedIn session.
  const leadScraper = app.get(LeadScraperService);
  const leadsService = app.get(LeadsService);
  const scrapeCursor = app.get(ScrapeCursorService);
  const scrapeJobs = app.get(ScrapeJobsService);
  const leadScrapeWorker = new Worker(
    'lead-scrape',
    async (job: Job) => {
      const { workspaceId, titles, location, maxResults, startFresh, scrapeJobId } = job.data;
      try {
        // Resume where the last run of this search stopped so a rerun finds new pages.
        const qk = scrapeCursor.queryKey(titles, location);
        if (startFresh) await scrapeCursor.reset(workspaceId, qk);
        const startPage = startFresh ? 0 : await scrapeCursor.nextPage(workspaceId, qk);
        const pages = Math.min(Math.max(Math.ceil((maxResults || 15) / 8), 1), 10);
        logger.info({ titles, location, maxResults, startPage, pages }, 'Processing lead-scrape job');
        await scrapeJobs.update(workspaceId, scrapeJobId, { status: 'running', stage: 'searching Google' });

        // Use the remote scraper when configured; fall back to local on failure.
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

        // Advance the cursor only when the run produced leads.
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
