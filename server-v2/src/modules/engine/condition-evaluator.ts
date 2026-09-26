import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '@/db';
import { withWorkspace } from '@/db/rls';

@Injectable()
export class ConditionEvaluator {
  /**
   * Is this step condition true for the lead? Pass `db` to read inside the caller's
   * workspace transaction; otherwise the read opens its own.
   */
  async evaluate(
    workspaceId: string,
    leadId: string,
    conditionType: string,
    _params: any,
    db?: Kysely<DatabaseSchema>,
  ): Promise<boolean> {
    const read = (d: Kysely<DatabaseSchema>) =>
      d
        .selectFrom('leads')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', leadId)
        .executeTakeFirst();
    const lead = db ? await read(db) : await withWorkspace(workspaceId, read);

    if (!lead) return false;

    switch (conditionType) {
      case 'if_connected':
        return lead.status === 'accepted' || lead.status === 'replied';

      case 'if_replied':
        return lead.status === 'replied';

      case 'if_followed_by_you':
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
