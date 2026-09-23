import { Injectable } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';

export type NewTemplate = {
  name: string;
  channel: 'linkedin' | 'email';
  subject: string | null;
  body: string;
};

/** Save/delete for message templates (the read side lives in TemplatesService). */
@Injectable()
export class TemplateWritesService {
  async create(workspaceId: string, userId: string, t: NewTemplate): Promise<any> {
    const row = await withWorkspace(workspaceId, (db) =>
      db
        .insertInto('templates')
        .values({
          workspace_id: workspaceId,
          // created_by is an FK to users — the bypass/API-key subjects are
          // placeholder UUIDs with no user row behind them.
          created_by: /^0{8}-/.test(userId) ? null : userId,
          name: t.name,
          channel: t.channel,
          subject: t.subject,
          body: t.body,
        })
        .returning(['id', 'name', 'channel', 'subject', 'body'])
        .executeTakeFirstOrThrow(),
    );
    return { ...row, subject: row.subject || undefined, used: 0, acceptPct: 0 };
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const res = await withWorkspace(workspaceId, (db) =>
      db
        .deleteFrom('templates')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    return Number(res.numDeletedRows) > 0;
  }
}
