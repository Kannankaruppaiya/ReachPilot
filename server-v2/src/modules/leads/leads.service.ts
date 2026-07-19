import { Injectable, NotFoundException } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';

@Injectable()
export class LeadsService {
  async list(workspaceId: string): Promise<any[]> {
    const rows = await withWorkspace(workspaceId, (db) =>
      db.selectFrom('leads').selectAll().execute(),
    );
    return rows.map((r) => this.mapToFrontend(r));
  }

  async update(workspaceId: string, id: string, data: any): Promise<any> {
    return withWorkspace(workspaceId, async (db) => {
      const existing = await db
        .selectFrom('leads')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) {
        throw new NotFoundException('Lead not found.');
      }

      const updates: Record<string, any> = {};
      if (data.status !== undefined) updates.status = data.status.toLowerCase();
      if (data.tags !== undefined) updates.tags = data.tags;
      if (data.lastActivity !== undefined) updates.last_activity = data.lastActivity;

      if (Object.keys(updates).length > 0) {
        await db.updateTable('leads').set(updates).where('id', '=', id).execute();
      }

      const updated = await db
        .selectFrom('leads')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      return this.mapToFrontend(updated);
    });
  }

  async importLeads(
    workspaceId: string,
    source: string,
    rows: any[],
  ): Promise<{ count: number }> {
    return withWorkspace(workspaceId, async (db) => {
      let count = 0;
      for (const row of rows) {
        const name = String(row.name || '').trim();
        const target = String(row.target || row.linkedinUrl || '').trim();
        if (!name || !target) continue;

        const firstName = name.split(' ')[0] || '';
        const email = String(row.email || '').trim().toLowerCase();
        const isEmail = /@/.test(email);

        const leadData: any = {
          workspace_id: workspaceId,
          full_name: name,
          first_name: firstName,
          title: String(row.role || row.title || '').trim(),
          company: String(row.company || '').trim(),
          location: String(row.location || '').trim(),
          linkedin_url: target.includes('linkedin.com') ? target : null,
          email: isEmail ? email : null,
          email_verified: isEmail,
          status: 'new',
          source,
          tags: row.tags || [],
          last_activity: 'Imported',
        };

        if (leadData.linkedin_url) {
          const existing = await db
            .selectFrom('leads')
            .select('id')
            .where('linkedin_url', '=', leadData.linkedin_url)
            .executeTakeFirst();

          if (existing) {
            await db
              .updateTable('leads')
              .set(leadData)
              .where('id', '=', existing.id)
              .execute();
            continue;
          }
        }

        await db.insertInto('leads').values(leadData).execute();
        count++;
      }

      // Add activity log
      await db.insertInto('activity').values({
        workspace_id: workspaceId,
        text: `Imported ${count} leads from Excel`,
        tone: 'accent',
      }).execute();

      return { count };
    });
  }

  private mapToFrontend(r: any) {
    return {
      id: r.id,
      name: r.full_name,
      firstName: r.first_name,
      title: r.title,
      company: r.company,
      location: r.location,
      linkedinUrl: r.linkedin_url || '',
      email: r.email || '',
      emailVerified: r.email_verified,
      status: r.status.charAt(0).toUpperCase() + r.status.slice(1),
      source: r.source,
      tags: r.tags || [],
      lastActivity: r.last_activity,
      createdAt: r.created_at,
    };
  }
}
