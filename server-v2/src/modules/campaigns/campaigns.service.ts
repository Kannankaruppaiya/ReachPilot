import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';

@Injectable()
export class CampaignsService {
  async list(workspaceId: string): Promise<any[]> {
    const rows = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('campaigns')
        .leftJoin('campaign_stats', 'campaign_stats.campaign_id', 'campaigns.id')
        .select([
          'campaigns.id',
          'campaigns.name',
          'campaigns.status',
          'campaigns.daily_cap',
          'campaigns.created_at',
          'campaign_stats.leads',
          'campaign_stats.sent',
          'campaign_stats.accepted_pct',
          'campaign_stats.replied_pct',
        ])
        .where('campaigns.workspace_id', '=', workspaceId)
        .execute(),
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status === 'paused' ? 'Paused' : r.status === 'active' ? 'Active' : r.status,
      leads: Number(r.leads || 0),
      sent: Number(r.sent || 0),
      acceptedPct: Number(r.accepted_pct || 0),
      repliedPct: Number(r.replied_pct || 0),
      trend: [] as number[], // real per-campaign trend not tracked yet — no mock
    }));
  }

  async create(workspaceId: string, name: string, dailyCap: number): Promise<any> {
    if (!name || !name.trim()) {
      throw new BadRequestException('Campaign name is required.');
    }

    const campaign = await withWorkspace(workspaceId, async (db) => {
      // Find default accounts if any
      const linkedinAcct = await db
        .selectFrom('linkedin_accounts')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .limit(1)
        .executeTakeFirst();

      const emailAcct = await db
        .selectFrom('email_accounts')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .limit(1)
        .executeTakeFirst();

      const created = await db
        .insertInto('campaigns')
        .values({
          workspace_id: workspaceId,
          name: name.trim(),
          status: 'draft',
          daily_cap: dailyCap || 15,
          linkedin_account_id: linkedinAcct?.id || null,
          email_account_id: emailAcct?.id || null,
        })
        .returning(['id', 'name', 'status', 'daily_cap', 'created_at'])
        .executeTakeFirstOrThrow();

      await db
        .insertInto('activity')
        .values({
          workspace_id: workspaceId,
          text: `Campaign "${created.name}" created`,
          tone: 'accent',
        })
        .execute();

      return created;
    });

    return {
      id: campaign.id,
      name: campaign.name,
      // Report the status we actually persisted, not a hardcoded one.
      status: 'Draft',
      leads: 0,
      sent: 0,
      acceptedPct: 0,
      repliedPct: 0,
      trend: [] as number[],
    };
  }

  async update(workspaceId: string, id: string, data: any): Promise<any> {
    return withWorkspace(workspaceId, async (db) => {
    const campaign = await db
      .selectFrom('campaigns')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();

    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }

    const updates: Record<string, any> = {};
    if (data.name !== undefined) updates.name = data.name.trim();
    if (data.status !== undefined) {
      const statusMap: Record<string, string> = {
        'Active': 'active',
        'Paused': 'paused',
        'Draft': 'draft',
        'Archived': 'archived',
        'active': 'active',
        'paused': 'paused',
        'draft': 'draft',
        'archived': 'archived',
      };
      updates.status = statusMap[data.status] || 'paused';
    }
    if (data.dailyCap !== undefined) updates.daily_cap = Number(data.dailyCap);

    if (Object.keys(updates).length > 0) {
      await db
        .updateTable('campaigns')
        .set(updates)
        .where('id', '=', id)
        .execute();
    }

    const stats = await db
      .selectFrom('campaign_stats')
      .selectAll()
      .where('campaign_id', '=', id)
      .executeTakeFirst();

    const updated = await db
      .selectFrom('campaigns')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    return {
      id: updated.id,
      name: updated.name,
      status: updated.status === 'paused' ? 'Paused' : updated.status === 'active' ? 'Active' : updated.status,
      leads: Number(stats?.leads || 0),
      sent: Number(stats?.sent || 0),
      acceptedPct: Number(stats?.accepted_pct || 0),
      repliedPct: Number(stats?.replied_pct || 0),
      trend: [] as number[],
    };
    });
  }
}
