import { Controller, Get, Post, Body, Req, UnauthorizedException, ForbiddenException, Logger } from '@nestjs/common';
import { Request } from 'express';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';
import { withWorkspace } from '@/db/rls';

/**
 * Endpoints the desktop agent polls. It authenticates with the user's Bearer
 * token, and the account comes from that workspace, so it can't poll another
 * workspace's queue.
 */
@Controller('api/agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);
  private redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });

  private workspaceId(req: Request): string {
    const user = (req as any).user as { workspaceId?: string; role?: string } | undefined;
    const ws = user?.workspaceId || (req as any).workspaceId;
    if (!ws) throw new UnauthorizedException('agent not authenticated');
    // Jobs carry decrypted credentials, so only owners/admins may run the agent
    // (not, e.g., a member-role API key).
    if (user?.role !== 'owner' && user?.role !== 'admin') {
      throw new ForbiddenException('Only a workspace owner/admin can act as the desktop agent.');
    }
    return ws;
  }

  /**
   * The account the desktop agent logs in as; its persistent profile is keyed by
   * this id. Sendable accounts first, newest first.
   */
  @Get('account')
  async account(@Req() req: Request) {
    const ws = this.workspaceId(req);
    const acct = await withWorkspace(ws, (db) =>
      db
        .selectFrom('linkedin_accounts')
        .select(['id', 'email', 'status'])
        .where('workspace_id', '=', ws)
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
    // Sent by 0.1.1+; a missing header means a build that needs a manual reinstall.
    const agentVersion = String((req.headers as any)['x-agent-version'] || '').slice(0, 32);

    // TEMP DIAG: which workspace/accounts is a desktop agent polling for?
    this.logger.log(
      `agent poll ws=${ws.slice(0, 8)} v=${agentVersion || 'legacy(pre-0.1.1, needs manual update)'} accounts=[${accounts.map((a) => a.id.slice(0, 8)).join(',')}]`,
    );

    // Heartbeat for every account in the workspace (30s TTL). If the key was
    // missing, the agent just came back: pull its deferred jobs forward.
    for (const a of accounts) {
      const wasOnline = await this.redis.get(`agent:hb:${a.id}`);
      // The heartbeat value is the agent version ('legacy' when absent); readers
      // only test truthiness.
      await this.redis.set(`agent:hb:${a.id}`, agentVersion || 'legacy', 'EX', 30);
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
        // Mark the job accepted so RemoteAgentDriver waits for its result instead of
        // rescheduling an already-sent action.
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
