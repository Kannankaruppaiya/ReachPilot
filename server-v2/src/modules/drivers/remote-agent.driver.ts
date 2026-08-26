import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { getEnv } from '@/config/env';
import {
  LinkedInDriver,
  LinkedInActionContext,
  LinkedInActionResult,
  LinkedInLoginContext,
  LinkedInLoginResult,
  LinkedInSyncResult,
} from './linkedin-driver.interface';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * RemoteAgentDriver — selected when LINKEDIN_DRIVER=remote (set this on the DC VM
 * / any server that must NOT run a browser). It NEVER launches Playwright. Instead
 * it hands each action to the user's DESKTOP AGENT (which runs the REAL driver on
 * the user's own residential IP) and waits for the result.
 *
 * Bridge = Redis (already on the server):
 *   - action pushed to `agent:inbox:<accountId>` (a queue the agent polls)
 *   - result read from `agent:result:<token>` (the agent posts it via REST)
 *
 * Implements the same LinkedInDriver interface, so the worker's linkedin-actions
 * loop (worker.ts ~line 298) dispatches to it unchanged.
 */
@Injectable()
export class RemoteAgentDriver implements LinkedInDriver {
  private readonly logger = new Logger(RemoteAgentDriver.name);
  private redis?: Redis;

  private getRedis(): Redis {
    if (!this.redis) this.redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    return this.redis;
  }

  /**
   * Push one job to the account's desktop agent and await its result JSON.
   *
   * Returns `{ result, accepted }`:
   *   - result  = the parsed result JSON, or null if none arrived in time.
   *   - accepted = whether the agent actually PICKED UP the job (rpop'd it, which
   *                stamps `agent:accepted:<token>`). This lets the caller tell a
   *                slow-but-running send apart from one the agent never took.
   *
   * Two timeouts:
   *   - pickupMs: if the agent never accepts the job within this window it's
   *     treated as unavailable (busy/stuck/offline) — nothing was sent, defer.
   *   - hardCapMs: once ACCEPTED, wait this much longer for the result. The desktop
   *     always posts a result, so this only elapses if the agent died mid-job; a
   *     real (slow) send now returns its true outcome in-flow instead of being
   *     misreported as agent_unavailable and rescheduled after it already went out.
   */
  private async pushAndWait(
    accountId: string,
    jobObj: Record<string, unknown>,
    opts: { pickupMs: number; hardCapMs: number },
  ): Promise<{ result: unknown | null; accepted: boolean }> {
    const redis = this.getRedis();
    const token = jobObj.token as string;
    const job = JSON.stringify(jobObj);
    const inbox = `agent:inbox:${accountId}`;
    const resultKey = `agent:result:${token}`;
    const acceptedKey = `agent:accepted:${token}`;

    // Fast offline check. The desktop agent writes a heartbeat (`agent:hb:<id>`)
    // on every poll (~5s). If none is present the agent is offline (laptop off /
    // app closed) — don't lpush into an inbox nobody reads and then block a worker
    // slot for the full timeout. Report unavailable immediately so the worker
    // defers the job cheaply; one user's offline laptop can't starve other tenants.
    if (!(await redis.get(`agent:hb:${accountId}`))) {
      this.logger.warn(`no agent heartbeat for ${accountId} — agent offline, deferring ${jobObj.action}`);
      return { result: null, accepted: false };
    }

    await redis.lpush(inbox, job);
    await redis.expire(inbox, 900);
    this.logger.log(`dispatched ${jobObj.action} for ${accountId} (token ${token.slice(0, 8)})`);

    const start = Date.now();
    let accepted = false;
    for (;;) {
      const raw = await redis.get(resultKey);
      if (raw) {
        await redis.del(resultKey);
        try {
          return { result: JSON.parse(raw), accepted: true };
        } catch {
          return { result: null, accepted: true };
        }
      }
      // Once the agent has picked the job up, be patient — the result is coming.
      if (!accepted) accepted = !!(await redis.get(acceptedKey));
      const elapsed = Date.now() - start;
      if (accepted) {
        if (elapsed > opts.hardCapMs) {
          // Accepted but no result even after the hard cap — the agent likely died
          // mid-job. Rare. Leave the (already rpop'd) job alone and report pending.
          this.logger.warn(`agent accepted ${jobObj.action}/${accountId} but never returned — deferring`);
          return { result: null, accepted: true };
        }
      } else if (elapsed > opts.pickupMs) {
        // Never picked up within the pickup window → busy/stuck agent. Pull it back
        // so it can't run late, and defer. Nothing was sent.
        await redis.lrem(inbox, 0, job).catch(() => undefined);
        this.logger.warn(`agent never picked up ${jobObj.action}/${accountId} — deferring`);
        return { result: null, accepted: false };
      }
      await sleep(1500);
    }
  }

  /** Push one action to the account's agent and await the result. */
  private async dispatch(
    action: string,
    ctx: LinkedInActionContext | undefined,
    payload: Record<string, unknown>,
  ): Promise<LinkedInActionResult> {
    const accountId = ctx?.accountId;
    if (!accountId) return { status: 'failed', error: 'no_account_id' };
    // The desktop agent runs jobs SERIALLY, and a connect flow includes a profile
    // load LinkedIn often stalls on (observed 30s+ gotos) plus note typing — so a
    // single action can run well past a minute. pushAndWait waits patiently ONCE
    // the agent has accepted the job (up to hardCapMs) so a slow-but-successful
    // send returns its true outcome instead of being misreported as offline and
    // rescheduling an already-sent invite; it only fast-fails (pickupMs) when the
    // agent never took the job at all (nothing sent → safe to defer).
    const res = await this.pushAndWait(
      accountId,
      // Forward the session cookie so the desktop agent acts as the logged-in
      // user. proxy/fingerprint are intentionally NOT sent — actions run on the
      // user's own residential IP + persistent profile, same as the login did.
      { token: randomUUID(), action, accountId, workspaceId: ctx?.workspaceId, li_at: ctx?.li_at, cookies: ctx?.cookies, ...payload },
      { pickupMs: 120_000, hardCapMs: 420_000 },
    );
    if (res.result) return res.result as LinkedInActionResult;
    // accepted (agent had it, no result) vs never-picked-up are handled differently
    // by the worker: 'agent_result_pending' means "may have gone out, re-verify"
    // while 'agent_unavailable' means "definitely not sent, agent offline/busy".
    return { status: 'failed', error: res.accepted ? 'agent_result_pending' : 'agent_unavailable' };
  }

  sendConnectRequest(targetUrl: string, message: string, ctx?: LinkedInActionContext) {
    return this.dispatch('connect_request', ctx, { targetUrl, message });
  }
  sendMessage(targetUrl: string, message: string, ctx?: LinkedInActionContext) {
    return this.dispatch('linkedin_message', ctx, { targetUrl, message });
  }
  visitProfile(targetUrl: string, ctx?: LinkedInActionContext) {
    return this.dispatch('visit_profile', ctx, { targetUrl });
  }
  follow(targetUrl: string, ctx?: LinkedInActionContext) {
    return this.dispatch('follow', ctx, { targetUrl });
  }
  sendInMail(targetUrl: string, subject: string, message: string, ctx?: LinkedInActionContext) {
    return this.dispatch('inmail', ctx, { targetUrl, subject, message });
  }
  likeRecentPost(targetUrl: string, ctx?: LinkedInActionContext) {
    return this.dispatch('like_post', ctx, { targetUrl });
  }
  endorseSkill(targetUrl: string, ctx?: LinkedInActionContext) {
    return this.dispatch('endorse_skill', ctx, { targetUrl });
  }

  // Sync + withdraw run on the desktop agent's own timer (not dispatched per-job);
  // return safe no-ops here so the server-side sync loop stays quiet in remote mode.
  async syncAccount(_ctx?: LinkedInActionContext): Promise<LinkedInSyncResult> {
    return { accepted: [], replies: [] };
  }
  async withdrawStaleInvites() {
    return { withdrawn: 0 };
  }
  // Login runs ON the desktop agent (one-time, on the user's own residential IP) —
  // never server-side. Dispatch the credentials to the agent and await the result.
  // Longer timeout than actions: a real login may involve a 2FA/checkpoint step.
  async login(ctx: LinkedInLoginContext): Promise<LinkedInLoginResult> {
    const accountId = ctx.accountId;
    if (!accountId) return { status: 'failed', error: 'no_account_id' };
    const res = await this.pushAndWait(
      accountId,
      {
        token: randomUUID(),
        action: 'login',
        accountId,
        workspaceId: ctx.workspaceId,
        email: ctx.email,
        password: ctx.password,
        totpSecret: ctx.totpSecret,
      },
      // A login can involve a 2FA/checkpoint step → be generous once accepted.
      { pickupMs: 120_000, hardCapMs: 420_000 },
    );
    if (res.result) return res.result as LinkedInLoginResult;
    return { status: 'failed', error: res.accepted ? 'agent_result_pending' : 'agent_unavailable' };
  }
}
