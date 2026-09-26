import { Injectable } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { LinkedinAccountsService } from '@/modules/accounts/linkedin-accounts.service';
import { PacingService } from '@/modules/engine/pacing.service';
import { whereRealSend } from '@/modules/jobs/real-sends';

/**
 * Job states that are still outstanding work. Never add failed/sent/canceled;
 * `queued` alone is only the brief BullMQ handoff.
 */
export const PENDING_JOB_STATUSES = ['scheduled', 'queued', 'running'] as const;

/**
 * Split outstanding work into "going out today" (bounded by today's cap) and
 * "later". The two always sum to the outstanding total.
 */
export function splitQueue(input: {
  dueToday: number;
  outstanding: number;
  dailyLimit: number | null | undefined;
  sentToday: number;
}): { sendingToday: number; scheduledLater: number } {
  const remaining = Math.max(0, (input.dailyLimit ?? 0) - input.sentToday);
  const sendingToday = Math.max(0, Math.min(input.dueToday, remaining, input.outstanding));
  return { sendingToday, scheduledLater: Math.max(0, input.outstanding - sendingToday) };
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly linkedin: LinkedinAccountsService,
    private readonly pacing: PacingService,
  ) {}

  async getDashboardData(workspaceId: string): Promise<any> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const counts = await withWorkspace(workspaceId, async (db) => {
      const jobCount = async (build: (q: any) => any): Promise<number> => {
        const r = (await build(
          db.selectFrom('jobs').select((eb: any) => eb.fn.count('id').as('cnt')),
        ).executeTakeFirst()) as any;
        return Number(r?.cnt || 0);
      };

      // whereRealSend, not status='sent': skipped leads are parked in `sent` too.
      const invitesSent = await jobCount((q) => whereRealSend(q.where('workspace_id', '=', workspaceId).where('kind', '=', 'linkedin')));
      const emailsSent = await jobCount((q) => q.where('workspace_id', '=', workspaceId).where('kind', '=', 'email').where('status', '=', 'sent'));
      // Split by due date. Both sides use PENDING_JOB_STATUSES.
      const endOfToday = new Date(startOfToday);
      endOfToday.setDate(endOfToday.getDate() + 1);
      const pending = (q: any) =>
        q.where('workspace_id', '=', workspaceId).where('status', 'in', PENDING_JOB_STATUSES as any);
      const dueToday = await jobCount((q) =>
        pending(q).where('scheduled_for', '<', endOfToday.toISOString()),
      );
      const outstanding = await jobCount((q) => pending(q));
      const sentToday = await jobCount((q) =>
        whereRealSend(q.where('workspace_id', '=', workspaceId).where('kind', '=', 'linkedin')).where('sent_at', '>=', startOfToday.toISOString()),
      );

      const leadCount = async (build: (q: any) => any): Promise<number> => {
        const r = (await build(
          db.selectFrom('leads').select((eb: any) => eb.fn.count('id').as('cnt')),
        ).executeTakeFirst()) as any;
        return Number(r?.cnt || 0);
      };
      const totalLeads = await leadCount((q) => q.where('workspace_id', '=', workspaceId));
      const accepted = await leadCount((q) => q.where('workspace_id', '=', workspaceId).where('status', 'in', ['accepted', 'replied']));
      const replies = await leadCount((q) => q.where('workspace_id', '=', workspaceId).where('status', '=', 'replied'));

      const activity = await db
        .selectFrom('activity')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();

      return { invitesSent, emailsSent, dueToday, outstanding, sentToday, totalLeads, accepted, replies, activity };
    });

    const acceptanceRate = counts.invitesSent > 0 ? Math.round((counts.accepted / counts.invitesSent) * 100) : 0;

    const state = await this.linkedin.getAccountState(workspaceId);
    const detail = await this.linkedin.getForWorkspace(workspaceId);

    // Use the jittered cap pacing enforces, not the ramp figure (LinkedIn only;
    // email is paced separately).
    const { sendingToday: queuedToday, scheduledLater: scheduled } = splitQueue({
      dueToday: counts.dueToday,
      outstanding: counts.outstanding,
      dailyLimit: this.effectiveDailyLimit(state.warmup?.todayLimit, detail),
      sentToday: counts.sentToday,
    });

    return {
      invitesSent: counts.invitesSent,
      emailsSent: counts.emailsSent,
      acceptanceRate,
      replies: counts.replies,
      meetings: 0, // no meetings source yet — honest zero, not a fake number
      totalLeads: counts.totalLeads,
      queuedToday,
      scheduled,
      sentToday: counts.sentToday,
      account: state.connected
        ? {
            status: state.status,
            loggedIn: state.loggedIn,
            warmup: state.warmup,
            country: detail?.country || null,
            dedicatedIp: detail?.proxy_ip || null,
          }
        : null,
      activity: counts.activity.map((a: any) => ({
        id: a.id,
        text: a.text,
        tone: a.tone,
        time: this.formatTimeDiff(new Date(a.created_at)),
      })),
    };
  }

  /** The jittered ceiling pacing will actually enforce for this account today. */
  private effectiveDailyLimit(base: number | null | undefined, account: any): number {
    if (!base || !account?.id) return base ?? 0;
    const dateIso = new Date().toLocaleDateString('en-US', { timeZone: account.timezone || 'UTC' });
    return this.pacing.jitterDailyLimit(base, account.id, dateIso);
  }

  private formatTimeDiff(d: Date): string {
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) return 'Yesterday';
    return d.toLocaleDateString();
  }
}
