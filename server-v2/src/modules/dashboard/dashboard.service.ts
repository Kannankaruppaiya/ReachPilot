import { Injectable } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { LinkedinAccountsService } from '@/modules/accounts/linkedin-accounts.service';
import { PacingService } from '@/modules/engine/pacing.service';

/**
 * The only job states that still represent OUTSTANDING work.
 *
 * 🔴 `failed`, `sent` and `canceled` must never be in here. A failed invite is
 * finished — counting it as pending tells the operator work is coming that never
 * will, and every terminal `no_connect_button` would inflate the queue forever.
 *
 * `queued` alone is not a queue either: it is the momentary BullMQ handoff, held
 * for seconds, so a counter built on it reads 0 essentially always — which is
 * exactly what "Sending today" showed while 71 jobs were due and overdue.
 */
export const PENDING_JOB_STATUSES = ['scheduled', 'queued', 'running'] as const;

/**
 * Split outstanding work into "going out today" and "later".
 *
 * 🔴 Being DUE today is not the same as GOING today. The warm-up cap bounds what
 * can actually leave: 53 jobs were due against a 20/day cap with 19 already sent,
 * so the honest answer was 1. Reporting 53 promises sends that pacing will refuse
 * — the mirror image of the 0 this panel used to show unconditionally.
 *
 * Nothing is dropped: whatever is not going today is counted as later, so the two
 * numbers always sum to the outstanding total.
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

    // All tenant-table reads run inside the workspace's RLS context. (Previously
    // these used raw getDb() and silently returned 0 for everything.)
    const counts = await withWorkspace(workspaceId, async (db) => {
      const jobCount = async (build: (q: any) => any): Promise<number> => {
        const r = (await build(
          db.selectFrom('jobs').select((eb: any) => eb.fn.count('id').as('cnt')),
        ).executeTakeFirst()) as any;
        return Number(r?.cnt || 0);
      };

      const invitesSent = await jobCount((q) => q.where('workspace_id', '=', workspaceId).where('kind', '=', 'linkedin').where('status', '=', 'sent'));
      const emailsSent = await jobCount((q) => q.where('workspace_id', '=', workspaceId).where('kind', '=', 'email').where('status', '=', 'sent'));
      // Split OUTSTANDING work by when it is due, not by which internal state it
      // happens to be parked in. Both sides share PENDING_JOB_STATUSES, so a
      // failed / sent / canceled job can never appear in either number.
      const endOfToday = new Date(startOfToday);
      endOfToday.setDate(endOfToday.getDate() + 1);
      const pending = (q: any) =>
        q.where('workspace_id', '=', workspaceId).where('status', 'in', PENDING_JOB_STATUSES as any);
      const dueToday = await jobCount((q) =>
        pending(q).where('scheduled_for', '<', endOfToday.toISOString()),
      );
      const outstanding = await jobCount((q) => pending(q));
      const sentToday = await jobCount((q) =>
        q.where('workspace_id', '=', workspaceId).where('kind', '=', 'linkedin').where('status', '=', 'sent').where('sent_at', '>=', startOfToday.toISOString()),
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

    // Real account + computed warm-up state (same source the shell uses).
    const state = await this.linkedin.getAccountState(workspaceId);
    const detail = await this.linkedin.getForWorkspace(workspaceId);

    // Use the ceiling PACING ENFORCES, not the ramp figure. The daily cap is
    // jittered +/-15% per account/day (anti-fingerprinting), so a 20/day ramp can
    // be 19 today — and reading the un-jittered 20 against 19 sent advertised one
    // more send that pacing had already refused. Same class of error twice over:
    // the panel must quote the number the sender obeys.
    // (The cap is the LinkedIn warm-up; email jobs are paced separately.)
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
