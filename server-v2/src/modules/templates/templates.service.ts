import { Injectable } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';

@Injectable()
export class TemplatesService {
  async list(workspaceId: string): Promise<any[]> {
    const rows = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('templates')
        .leftJoin('template_stats', 'template_stats.template_id', 'templates.id')
        .select([
          'templates.id',
          'templates.name',
          'templates.channel',
          'templates.subject',
          'templates.body',
          'template_stats.used',
          'template_stats.accept_pct',
        ])
        .where('templates.workspace_id', '=', workspaceId)
        .execute(),
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      channel: r.channel,
      subject: r.subject || undefined,
      body: r.body,
      used: Number(r.used || 0),
      acceptPct: Number(r.accept_pct || 0),
    }));
  }

  async getTemplate(workspaceId: string, id: string): Promise<any> {
    const db = getDb();
    return db
      .selectFrom('templates')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
  }
}
