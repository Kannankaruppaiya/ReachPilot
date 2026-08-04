import { Injectable, Logger } from '@nestjs/common';
import { getDb } from '@/db';
import { GraphExecutor } from './graph-executor';

/**
 * The heartbeat of the campaign sequence engine.
 *
 * `GraphExecutor.executeStep` knows how to run ONE step of ONE enrollment, and
 * the worker's post-send `advanceEnrollment` flips a finished step's enrollment
 * back to `active`. What was missing is the thing that drives the loop: on each
 * tick this finds every enrollment that is ready to move — freshly `active`, or
 * `waiting` with its wait window elapsed — inside a currently-active campaign,
 * and hands it to the executor. Without it a sequence never advances past the
 * step the enroll call kicked off.
 *
 * Enrollments are RLS-scoped, so we enumerate workspaces (not RLS'd) and drive
 * each under its own tenant context — the same pattern the scheduler uses.
 * `executeStep` is idempotent (one job per enrollment+step), so re-visiting a
 * still-parked enrollment is a no-op.
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
      const nowIso = new Date().toISOString();
      const workspaces = await getDb().selectFrom('workspaces').select('id').execute();
      for (const ws of workspaces) {
        try {
          // Due enrollments: active now, or waiting with the wait window elapsed,
          // belonging to a campaign that is actively running.
          const due = await getDb()
            .selectFrom('enrollments')
            .innerJoin('campaigns', 'campaigns.id', 'enrollments.campaign_id')
            .select('enrollments.id as id')
            .where('enrollments.workspace_id', '=', ws.id)
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
            .execute();

          for (const e of due) {
            try {
              await this.executor.executeStep(ws.id, e.id);
              advanced++;
            } catch (err: any) {
              this.logger.warn({ enrollmentId: e.id, err: err.message }, 'executeStep failed');
            }
          }
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
}
