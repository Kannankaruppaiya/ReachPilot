import { Controller, Get, Post, Body, Req, UnauthorizedException, ForbiddenException, Logger } from '@nestjs/common';
import { Request } from 'express';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';
import { withWorkspace } from '@/db/rls';

/**
 * Bridge between the server-side RemoteAgentDriver (which pushes actions to Redis
 * `agent:inbox:<accountId>`) and the user's DESKTOP AGENT (which runs the real
 * driver on the user's own IP). The agent authenticates with the user's normal
 * Bearer token; the account is derived from the authenticated workspace, so the
 * agent can never poll another workspace's queue.
 */
@Controller('api/agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);
  private redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });

  private workspaceId(req: Request): string {
    const user = (req as any).user as { workspaceId?: string; role?: string } | undefined;
    const ws = user?.workspaceId || (req as any).workspaceId;
    if (!ws) throw new UnauthorizedException('agent not authenticated');
    // next-job returns the raw decrypted job payload (li_at cookie for an
    // action, or email/password/TOTP for a login), and job-result accepts an
    // outcome for it — this must be reachable only by whoever is meant to run
    // the desktop agent, not by every credential that happens to authenticate
    // to this workspace. In particular a 'member'-role API key (meant for
    // read-only integrations) could otherwise race the real desktop client
    // for this data. Restrict to the account-management roles.
    if (user?.role !== 'owner' && user?.role !== 'admin') {
      throw new ForbiddenException('Only a workspace owner/admin can act as the desktop agent.');
    }
    return ws;
  }

  /**
   * The account the desktop agent should log in AS. The desktop keys its
   * persistent LinkedIn profile by this id (reachpilot-profiles/<accountId>),
   * which is the SAME id the dispatched jobs carry — so the one-time login and
   * the later actions share one session. Sendable accounts win over
   * paused/disconnected ones, newest first.
   */
  @Get('account')
  async account(@Req() req: Request) {
    const ws = this.workspaceId(req);
    const acct = await withWorkspace(ws, (db) =>
      db
        .selectFrom('linkedin_accounts')
        .select(['id', 'email', 'status'])
        .where('workspace_id', '=', ws)
        // sendable (active/warming_up) first, then most recently connected.
        .orderBy((eb) =>
          eb.case().when('status', 'in', ['paused', 'disconnected', 'checkpoint']).then(1).else(0).end(),
        )
        .orderBy('connected_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    if (!acct) return { account: null };
    return { account: { accountId: acct.id, email: acct.email, status: acct.status } };
  }

  /** Pull the next queued action for one of this workspace's accounts (or null). */
  @Get('next-job')
  async next(@Req() req: Request) {
    const ws = this.workspaceId(req);
    const accounts = await withWorkspace(ws, (db) =>
      db.selectFrom('linkedin_accounts').select('id').where('workspace_id', '=', ws).execute(),
    );
    // TEMP DIAG: which workspace/accounts is a desktop agent polling for?
    this.logger.log(`agent poll ws=${ws.slice(0, 8)} accounts=[${accounts.map((a) => a.id.slice(0, 8)).join(',')}]`);

    // Heartbeat + wake-on-reconnect. This poll proves a live desktop agent is
    // online for every account in the workspace right now (the worker's
    // RemoteAgentDriver reads `agent:hb:<accountId>` to skip dispatching to an
    // offline agent). Short TTL (agent polls ~every 5s), so the key is only absent
    // when the app was closed / laptop was off for >30s. Absent-then-present = a
    // WAKE: pull that account's agent-offline-deferred jobs forward to now so the
    // scheduler runs them on its next tick (~30s) instead of waiting out the
    // backoff. Pacing still caps them at the daily warm-up limit.
    for (const a of accounts) {
      const wasOnline = await this.redis.get(`agent:hb:${a.id}`);
      await this.redis.set(`agent:hb:${a.id}`, '1', 'EX', 30);
      if (!wasOnline) {
        const nowIso = new Date().toISOString();
        const res = await withWorkspace(ws, (db) =>
          db
            .updateTable('jobs')
            .set({ scheduled_for: nowIso as any })
            .where('workspace_id', '=', ws)
            .where('linkedin_account_id', '=', a.id)
            .where('status', '=', 'scheduled')
            .where('last_error', '=', 'agent_unavailable')
            .where('scheduled_for', '>', nowIso as any)
            .executeTakeFirst(),
        );
        const woke = res ? Number(res.numUpdatedRows) : 0;
        if (woke > 0) this.logger.log(`agent reconnect ${a.id.slice(0, 8)} — woke ${woke} deferred job(s)`);
      }
    }

    for (const a of accounts) {
      const raw = await this.redis.rpop(`agent:inbox:${a.id}`);
      if (raw) {
        const job = JSON.parse(raw);
        // Mark the job ACCEPTED so the server-side RemoteAgentDriver can tell a job
        // the agent actually took (and is now running on this machine) apart from
        // one that was never picked up. This is what stops a slow-but-successful
        // send being misreported as agent_unavailable: once accepted, the driver
        // waits patiently for the result instead of giving up and rescheduling an
        // already-sent invite. TTL covers the longest realistic action (incl. a
        // login with a 2FA/checkpoint step). Best-effort — a lost marker just
        // degrades to the old give-up behaviour, never a wrong send.
        if (job?.token) {
          await this.redis.set(`agent:accepted:${job.token}`, '1', 'EX', 900).catch(() => undefined);
        }
        return { job };
      }
    }
    return { job: null };
  }

  /** Post the result of an executed action (token was issued server-side). */
  @Post('job-result')
  async result(@Body() body: { token?: string; result?: unknown }, @Req() req: Request) {
    this.workspaceId(req); // must be authenticated
    if (!body?.token) return { ok: false };
    await this.redis.set(
      `agent:result:${body.token}`,
      JSON.stringify(body.result ?? { status: 'failed', error: 'no_result' }),
      'EX',
      200,
    );
    return { ok: true };
  }
}
