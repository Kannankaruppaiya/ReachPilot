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
 * LINKEDIN_DRIVER=remote: never launches a browser. Hands each action to the
 * user's desktop agent over Redis (`agent:inbox:<accountId>` in,
 * `agent:result:<token>` out) and waits for the result.
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
   * Push a job to the account's desktop agent and wait for its result.
   * `accepted` says whether the agent picked it up. Not picked up within
   * `pickupMs` → unavailable, nothing sent. Once accepted, wait up to `hardCapMs`
   * so a slow real send returns its true outcome.
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

    // No heartbeat = agent offline: report unavailable at once instead of blocking a
    // worker slot for the full timeout.
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
      if (!accepted) accepted = !!(await redis.get(acceptedKey));
      const elapsed = Date.now() - start;
      if (accepted) {
        if (elapsed > opts.hardCapMs) {
          // Accepted but no result: the agent likely died mid-job. Report pending.
          this.logger.warn(`agent accepted ${jobObj.action}/${accountId} but never returned — deferring`);
          return { result: null, accepted: true };
        }
      } else if (elapsed > opts.pickupMs) {
        // Never picked up: pull it back so it can't run late, and defer. Nothing was sent.
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
    // The agent runs jobs serially and a connect can take over a minute; the
    // timeouts are explained on pushAndWait.
    const res = await this.pushAndWait(
      accountId,
      // Send the session cookies. Proxy/fingerprint are not sent: the agent uses the
      // user's own IP and persistent profile.
      { token: randomUUID(), action, accountId, workspaceId: ctx?.workspaceId, li_at: ctx?.li_at, cookies: ctx?.cookies, ...payload },
      { pickupMs: 120_000, hardCapMs: 420_000 },
    );
    if (res.result) return res.result as LinkedInActionResult;
    // 'agent_result_pending' = may have been sent; 'agent_unavailable' = not sent.
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

  // Sync and withdraw run on the desktop agent's own timer; no-ops here.
  async syncAccount(_ctx?: LinkedInActionContext): Promise<LinkedInSyncResult> {
    return { accepted: [], replies: [] };
  }
  async withdrawStaleInvites() {
    return { withdrawn: 0 };
  }
  // Login runs on the desktop agent, never server-side; longer timeout for 2FA.
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
      { pickupMs: 120_000, hardCapMs: 420_000 },
    );
    if (res.result) return res.result as LinkedInLoginResult;
    return { status: 'failed', error: res.accepted ? 'agent_result_pending' : 'agent_unavailable' };
  }
}
