import { Injectable } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';

@Injectable()
export class AnalyticsService {
  async getDailyStats(workspaceId: string): Promise<any[]> {
    const rows = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('daily_stats')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .orderBy('day', 'asc')
        .execute(),
    );

    return rows.map((r) => ({
      day: r.day.toString(),
      invites: Number(r.invites_sent),
      accepted: Number(r.accepted),
      replies: Number(r.replies),
    }));
  }

  async getHourlyHeatmap(workspaceId: string): Promise<any[]> {
    return withWorkspace(workspaceId, (db) =>
      db.selectFrom('hourly_stats').selectAll().where('workspace_id', '=', workspaceId).execute(),
    );
  }

  async getChannelComparison(workspaceId: string): Promise<any[]> {
    const result = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('daily_stats')
        .select([
          (eb: any) => eb.fn.sum('invites_sent').as('linkedin_sent'),
          (eb: any) => eb.fn.sum('emails_sent').as('email_sent'),
          (eb: any) => eb.fn.sum('replies').as('total_replies'),
        ])
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst(),
    );

    return [
      { channel: 'LinkedIn', replies: Number(result?.total_replies || 0) },
      { channel: 'Email', replies: 0 },
    ];
  }
}
