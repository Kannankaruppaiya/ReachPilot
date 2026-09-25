import { Injectable } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { GraphExecutor } from './graph-executor';

@Injectable()
export class EngineService {
  constructor(private readonly executor: GraphExecutor) {}

  /**
   * Enroll a lead into a campaign sequence at its entry step.
   */
  async enrollLead(workspaceId: string, campaignId: string, leadId: string): Promise<void> {
    // campaigns and enrollments are RLS-scoped — read and write under the
    // workspace context, not raw getDb().
    const enrollment = await withWorkspace(workspaceId, async (db) => {
      const campaign = await db
        .selectFrom('campaigns')
        .select('entry_step_id')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', campaignId)
        .executeTakeFirst();

      if (!campaign || !campaign.entry_step_id) return null;

      return db
        .insertInto('enrollments')
        .values({
          workspace_id: workspaceId,
          campaign_id: campaignId,
          lead_id: leadId,
          current_step_id: campaign.entry_step_id,
          status: 'active',
        })
        .onConflict((oc) => oc.columns(['campaign_id', 'lead_id']).doUpdateSet({
          status: 'active',
          current_step_id: campaign.entry_step_id,
        }))
        .returning('id')
        .executeTakeFirstOrThrow();
    });

    if (!enrollment) return;

    // Trigger execution
    await this.executor.executeStep(workspaceId, enrollment.id);
  }
}
