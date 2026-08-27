import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { SecretsService } from '@/modules/vault/secrets.service';
import { ProxiesService } from './proxies.service';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { computeWarmup, warmupOrigin } from '@/modules/engine/warmup';
import { decideLogin } from './login-policy';

let loginQueue: Queue | null = null;
let loginRedis: Redis | null = null;
export function getLoginQueue(): Queue {
  if (loginQueue) return loginQueue;
  if (!loginRedis) loginRedis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  loginQueue = new Queue('linkedin-login', { connection: loginRedis as any });
  return loginQueue;
}
function getLoginRedis(): Redis {
  if (!loginRedis) loginRedis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return loginRedis;
}

@Injectable()
export class LinkedinAccountsService {
  private readonly logger = new Logger(LinkedinAccountsService.name);

  constructor(
    private readonly secrets: SecretsService,
    private readonly proxies: ProxiesService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /**
   * Enqueue the one-time login job that logs in through the account's proxy
   * and captures + stores the li_at session cookie. Runs after credentials
   * (password + optional 2FA) are in place.
   */
  private async enqueueLogin(
    workspaceId: string,
    opts: { forced?: boolean } = {},
  ): Promise<void> {
    // Scope EXPLICITLY by workspace_id — the DB connection bypasses RLS, so
    // relying on withWorkspace alone would pick the globally-first account (a
    // cross-tenant leak). Pick the most recently connected one in THIS workspace.
    const account = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('linkedin_accounts')
        .select(['id', 'session_secret_id'])
        .where('workspace_id', '=', workspaceId)
        .orderBy('connected_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    if (!account) return;

    // Is a login already rate-limited? Peek first so the decision below sees the
    // real state (the SET NX that claims the window happens once we've decided).
    const cdKey = `login:cooldown:${account.id}`;
    const cooldownActive = !!(await getLoginRedis().get(cdKey).catch(() => null));

    const decision = decideLogin({
      hasSession: !!account.session_secret_id,
      forced: !!opts.forced,
      cooldownActive,
    });

    if (!decision.enqueue) {
      this.logger.warn(`Not logging in ${account.id} — ${decision.reason}`);
      return;
    }

    // A forced login means the user just re-entered their credentials, so the
    // stored cookie is by definition suspect. Drop it BEFORE enqueuing: while it
    // is still there it blocks the very login meant to replace it, which is how
    // a signed-out account became unrecoverable (three "Update login" presses,
    // three stored credential sets, zero logins). See `login-policy.ts`.
    if (decision.clearStoredSession) {
      await withWorkspace(workspaceId, (db) =>
        db
          .updateTable('linkedin_accounts')
          // Explicit workspace scope — the DB role bypasses RLS.
          .where('workspace_id', '=', workspaceId)
          .where('id', '=', account.id)
          .set({ session_secret_id: null })
          .execute(),
      );
      this.logger.log(`Cleared the stale stored session for ${account.id} before re-login`);
    }

    // Claim the cool-down window. SET NX so two concurrent presses still yield
    // one login; Redis down → don't block the connect flow.
    await getLoginRedis()
      .set(cdKey, String(Date.now()), 'EX', decision.cooldownSeconds, 'NX')
      .catch(() => 'OK');

    await getLoginQueue().add(
      'login',
      { accountId: account.id, workspaceId },
      { attempts: 2, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: true },
    );
    this.logger.log(`Enqueued LinkedIn login for account ${account.id}`);
  }

  async connect(
    workspaceId: string,
    userId: string,
    email: string,
    password: string,
    country: string,
  ): Promise<{ dedicatedIp: string; country: string }> {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) {
      throw new BadRequestException('Enter a valid LinkedIn email address.');
    }
    if (!password || password.length < 6) {
      throw new BadRequestException('LinkedIn password must be at least 6 characters.');
    }
    if (!country) {
      throw new BadRequestException('Select a country for your dedicated IP.');
    }

    const passwordSecretId = await this.secrets.encrypt(password, 'linkedin_password', {
      workspaceId,
    });

    const proxy = await this.proxies.assignProxy(country);

    await withWorkspace(workspaceId, async (db) => {
      const existing = await db
        .selectFrom('linkedin_accounts')
        .select('id')
        .where('email', '=', email.toLowerCase())
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable('linkedin_accounts')
          .set({
            country,
            proxy_id: proxy?.id || null,
            password_secret_id: passwordSecretId,
            status: 'connecting',
            // NOT connected_at. It marks when this account STARTED running, and
            // the warm-up ramp measures from it — rewriting it here restarted a
            // month-old account's ramp at 5/day every time its password was
            // re-entered. (warmupOrigin() now also guards against this, but the
            // field should mean what its name says.)
          })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await db
          .insertInto('linkedin_accounts')
          .values({
            workspace_id: workspaceId,
            owner_user_id: userId,
            email: email.toLowerCase(),
            country,
            proxy_id: proxy?.id || null,
            password_secret_id: passwordSecretId,
            status: 'warming_up',
            connected_at: new Date().toISOString(),
          })
          .execute();
      }
    });

    await this.workspaces.updateOnboardingStep(workspaceId, 2);

    return {
      dedicatedIp: proxy?.ip || '0.0.0.0',
      country,
    };
  }

  async verifyTwoFa(workspaceId: string, secret: string): Promise<{ status: string }> {
    const cleaned = (secret || '').replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z2-7]{16,}$/.test(cleaned)) {
      throw new BadRequestException(
        "That doesn't look like a valid authenticator secret (base32, 16+ characters).",
      );
    }

    const secretId = await this.secrets.encrypt(cleaned, 'linkedin_totp', { workspaceId });

    await withWorkspace(workspaceId, (db) =>
      db
        .updateTable('linkedin_accounts')
        // Explicit workspace scope — the DB role bypasses RLS, so an un-scoped
        // UPDATE would set twofa/totp on EVERY tenant's accounts.
        .where('workspace_id', '=', workspaceId)
        .set({ twofa: 'verified', totp_secret_id: secretId })
        .execute(),
    );

    await this.workspaces.updateOnboardingStep(workspaceId, 3);

    // Credentials + 2FA in place → capture the session cookie.
    await this.enqueueLogin(workspaceId, { forced: true }).catch((e) =>
      this.logger.error(`Failed to enqueue login: ${e.message}`),
    );

    return { status: 'verified' };
  }

  async skipTwoFa(workspaceId: string): Promise<{ status: string }> {
    await withWorkspace(workspaceId, (db) =>
      db
        .updateTable('linkedin_accounts')
        // Explicit workspace scope — the DB role bypasses RLS.
        .where('workspace_id', '=', workspaceId)
        .set({ twofa: 'skipped' })
        .execute(),
    );

    await this.workspaces.updateOnboardingStep(workspaceId, 3);

    // No 2FA, but password is in place → attempt login / cookie capture.
    await this.enqueueLogin(workspaceId, { forced: true }).catch((e) =>
      this.logger.error(`Failed to enqueue login: ${e.message}`),
    );

    return { status: 'skipped' };
  }

  /**
   * Live account state for the app shell: connection status, whether a session
   * cookie is actually captured, and the REAL computed warm-up numbers (same
   * curve the pacing engine enforces). Returns connected:false when no account
   * exists so the UI can hide the warm-up widget/badge instead of faking data.
   */
  async getAccountState(workspaceId: string): Promise<{
    connected: boolean;
    loggedIn: boolean;
    status: string;
    email: string | null;
    dailyLimit: number | null;
    weeklyInviteCap: number | null;
    warmup: ReturnType<typeof computeWarmup> | null;
    hoursStart: string | null;
    hoursEnd: string | null;
    timezone: string | null;
    sendWeekends: boolean | null;
    loginIp: string | null;
    lastIp: string | null;
    lastIpAt: string | null;
  }> {
    const acct = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('linkedin_accounts')
        .select([
          'email',
          'status',
          'warmup_daily_limit',
          'warmup_target',
          'weekly_invite_cap',
          'connected_at',
          'created_at',
          'session_secret_id',
          'hours_start',
          'hours_end',
          'timezone',
          'send_weekends',
          'login_ip',
          'last_ip',
          'last_ip_at',
        ])
        // Explicit workspace scope (the DB connection bypasses RLS) + deterministic
        // pick: sendable accounts first, then most recently connected.
        .where('workspace_id', '=', workspaceId)
        .orderBy((eb) =>
          eb.case().when('status', 'in', ['paused', 'disconnected', 'checkpoint']).then(1).else(0).end(),
        )
        .orderBy('connected_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );

    if (!acct) {
      return {
        connected: false, loggedIn: false, status: 'none', email: null,
        dailyLimit: null, weeklyInviteCap: null, warmup: null,
        hoursStart: null, hoursEnd: null, timezone: null, sendWeekends: null,
        loginIp: null, lastIp: null, lastIpAt: null,
      };
    }

    return {
      connected: true,
      loggedIn: !!acct.session_secret_id,
      status: acct.status,
      email: acct.email,
      dailyLimit: acct.warmup_daily_limit,
      weeklyInviteCap: acct.weekly_invite_cap,
      warmup: computeWarmup(warmupOrigin(acct.connected_at, acct.created_at), acct.warmup_daily_limit, acct.warmup_target),
      // Postgres `time` comes back as "HH:MM:SS" — trim to "HH:MM" for <input type="time">.
      hoursStart: acct.hours_start ? String(acct.hours_start).slice(0, 5) : '09:00',
      hoursEnd: acct.hours_end ? String(acct.hours_end).slice(0, 5) : '18:00',
      timezone: acct.timezone || 'UTC',
      sendWeekends: !!acct.send_weekends,
      loginIp: (acct as any).login_ip ?? null,
      lastIp: (acct as any).last_ip ?? null,
      lastIpAt: (acct as any).last_ip_at ? String((acct as any).last_ip_at) : null,
    };
  }

  /**
   * The ONE place limits are changed — Settings → LinkedIn limits. Persists the
   * user's daily ceiling (warmup_daily_limit) and weekly invite cap; the pacing
   * engine reads these same columns, so what's saved here is what's enforced.
   */
  async updateLimits(
    workspaceId: string,
    dailyLimit: number,
    weeklyInviteCap: number,
    warmupTarget?: number,
    schedule?: { hoursStart?: string; hoursEnd?: string; timezone?: string; sendWeekends?: boolean },
  ): Promise<ReturnType<LinkedinAccountsService['getAccountState']>> {
    const daily = Math.trunc(Number(dailyLimit));
    const weekly = Math.trunc(Number(weeklyInviteCap));
    if (!Number.isFinite(daily) || daily < 1 || daily > 100) {
      throw new BadRequestException('Daily connection requests must be between 1 and 100.');
    }
    if (!Number.isFinite(weekly) || weekly < 1 || weekly > 200) {
      throw new BadRequestException('Weekly invite cap must be between 1 and 200.');
    }

    // Warm-up target = the daily ceiling the ramp climbs toward. Optional; only
    // updated when supplied. Kept conservative (real safe limits vary per account).
    const fields: {
      warmup_daily_limit: number;
      weekly_invite_cap: number;
      warmup_target?: number;
      hours_start?: string;
      hours_end?: string;
      timezone?: string;
      send_weekends?: boolean;
    } = {
      warmup_daily_limit: daily,
      weekly_invite_cap: weekly,
    };
    if (warmupTarget !== undefined && warmupTarget !== null) {
      const targetVal = Math.trunc(Number(warmupTarget));
      if (!Number.isFinite(targetVal) || targetVal < 5 || targetVal > 100) {
        throw new BadRequestException('Warm-up target must be between 5 and 100.');
      }
      fields.warmup_target = targetVal;
      // The target is the single daily ceiling — keep warmup_daily_limit in sync
      // so the two columns can never disagree and secretly cap the ramp below it.
      fields.warmup_daily_limit = targetVal;
    }

    // Working hours / timezone / weekends. All optional; overnight windows
    // (end before start) are allowed — the pacing engine wraps past midnight.
    if (schedule) {
      const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (schedule.hoursStart !== undefined) {
        if (!timeRe.test(schedule.hoursStart)) {
          throw new BadRequestException('Start time must be in HH:MM (24-hour) format.');
        }
        fields.hours_start = schedule.hoursStart;
      }
      if (schedule.hoursEnd !== undefined) {
        if (!timeRe.test(schedule.hoursEnd)) {
          throw new BadRequestException('End time must be in HH:MM (24-hour) format.');
        }
        fields.hours_end = schedule.hoursEnd;
      }
      if (schedule.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone });
        } catch {
          throw new BadRequestException('Invalid timezone.');
        }
        fields.timezone = schedule.timezone;
      }
      if (schedule.sendWeekends !== undefined) {
        fields.send_weekends = !!schedule.sendWeekends;
      }
    }

    const updated = await withWorkspace(workspaceId, (db) =>
      db
        .updateTable('linkedin_accounts')
        .set(fields)
        .returning('id')
        .execute(),
    );
    if (updated.length === 0) {
      throw new BadRequestException('Connect a LinkedIn account before setting limits.');
    }

    return this.getAccountState(workspaceId);
  }

  async getForWorkspace(workspaceId: string): Promise<any> {
    return withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('linkedin_accounts')
        .leftJoin('proxies', 'proxies.id', 'linkedin_accounts.proxy_id')
        .select([
          'linkedin_accounts.email',
          'linkedin_accounts.country',
          'linkedin_accounts.twofa',
          'linkedin_accounts.status',
          'linkedin_accounts.warmup_daily_limit',
          'linkedin_accounts.warmup_target',
          'linkedin_accounts.weekly_invite_cap',
          'linkedin_accounts.hours_start',
          'linkedin_accounts.hours_end',
          'linkedin_accounts.send_weekends',
          'linkedin_accounts.id',
          'proxies.ip as proxy_ip',
        ])
        // Explicit workspace scope (DB connection bypasses RLS) + deterministic pick.
        .where('linkedin_accounts.workspace_id', '=', workspaceId)
        .orderBy('linkedin_accounts.connected_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
  }
}
