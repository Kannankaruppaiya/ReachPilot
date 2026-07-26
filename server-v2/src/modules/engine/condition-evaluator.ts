import { Injectable } from '@nestjs/common';
import { getDb } from '@/db';

@Injectable()
export class ConditionEvaluator {
  /**
   * Evaluates if a specific step condition is true or false for a lead.
   */
  async evaluate(
    workspaceId: string,
    leadId: string,
    conditionType: string,
    _params: any,
  ): Promise<boolean> {
    const db = getDb();
    const lead = await db
      .selectFrom('leads')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', leadId)
      .executeTakeFirst();

    if (!lead) return false;

    switch (conditionType) {
      case 'if_connected':
        return lead.status === 'accepted' || lead.status === 'replied';

      case 'if_replied':
        return lead.status === 'replied';

      case 'if_followed_by_you':
        // Check lead activity or metadata if we followed them
        return lead.last_activity === 'Followed profile';

      case 'if_has_email':
        return !!lead.email;

      case 'if_email_opened':
        // In the simulator we check leads enrichment or mock open
        return !!(lead.enrichment as any)?.email_opened;

      case 'if_email_clicked':
        return !!(lead.enrichment as any)?.email_clicked;

      case 'if_inmail_opened':
        return !!(lead.enrichment as any)?.inmail_opened;

      case 'if_profile_visited':
        return !!(lead.enrichment as any)?.profile_visited;

      case 'if_post_liked':
        return !!(lead.enrichment as any)?.post_liked;

      default:
        return false;
    }
  }
}
