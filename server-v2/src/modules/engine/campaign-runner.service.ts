import { Injectable, Logger } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { GraphExecutor } from './graph-executor';

/**
 * Drives enrollments: each tick hands every ready enrollment (active, or waiting
 * with its window elapsed, in an active campaign) to GraphExecutor.executeStep,
 * which is idempotent. Runs per workspace under its own RLS context.
 */
@Injectable()
export class CampaignRunnerService {
  private readonly logger = new Logger(CampaignRunnerService.name);
  private ticking = false;

  constructor(private readonly executor: GraphExecutor) {}

  async tick(): Promise<{ advanced: number }> {
    if (this.ticking) {
      this.logger.debug('Campaign tick still running — skipping this interval');
      return { advanced: 0 };
    }
    this.ticking = true;
    let advanced = 0;
    try {
      const workspaces = await getDb().selectFrom('workspaces').select('id').execute();
      for (const ws of workspaces) {
        try {
          advanced += (await this.drainWorkspace(ws.id)).advanced;
        } catch (err: any) {
          this.logger.warn({ workspaceId: ws.id, err: err.message }, 'Campaign drain failed');
        }
      }
      if (advanced) this.logger.log(`Campaign tick: advanced ${advanced} enrollment(s)`);
    } finally {
      this.ticking = false;
    }
    return { advanced };
  }

  /** Drive one workspace's due enrollments. Tests call this, never tick(). */
  private async drainWorkspace(workspaceId: string): Promise<{ advanced: number }> {
    const nowIso = new Date().toISOString();
    // Due enrollments in active campaigns, read under the workspace's RLS context.
    const due = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('enrollments')
        .innerJoin('campaigns', 'campaigns.id', 'enrollments.campaign_id')
        .select('enrollments.id as id')
        .where('enrollments.workspace_id', '=', workspaceId)
        .where('campaigns.status', '=', 'active')
        .where((eb) =>
          eb.or([
            eb('enrollments.status', '=', 'active'),
            eb.and([
              eb('enrollments.status', '=', 'waiting'),
              eb.or([
                eb('enrollments.next_run_at', 'is', null),
                eb('enrollments.next_run_at', '<=', nowIso as any),
              ]),
            ]),
          ]),
        )
        .orderBy('enrollments.next_run_at', 'asc')
        .limit(200)
        .execute(),
    );

    let advanced = 0;
    for (const e of due) {
      try {
        await this.executor.executeStep(workspaceId, e.id);
        advanced++;
      } catch (err: any) {
        this.logger.warn({ enrollmentId: e.id, err: err.message }, 'executeStep failed');
      }
    }
    return { advanced };
  }
}
