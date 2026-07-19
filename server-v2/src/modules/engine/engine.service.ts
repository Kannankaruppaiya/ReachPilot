import { Injectable } from '@nestjs/common';
import { getDb } from '@/db';
import { GraphExecutor } from './graph-executor';

@Injectable()
export class EngineService {
  constructor(private readonly executor: GraphExecutor) {}

  /**
   * Enroll a lead into a campaign sequence at its entry step.
   */
  async enrollLead(workspaceId: string, campaignId: string, leadId: string): Promise<void> {
    const db = getDb();
    const campaign = await db
      .selectFrom('campaigns')
      .select('entry_step_id')
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', campaignId)
      .executeTakeFirst();

    if (!campaign || !campaign.entry_step_id) return;

    const enrollment = await db
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

    // Trigger execution
    await this.executor.executeStep(workspaceId, enrollment.id);
  }
}
