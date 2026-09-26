import { BadRequestException, Injectable } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { sendableMailboxes } from './mailbox';

@Injectable()
export class EmailAccountsService {
  constructor(private readonly workspaces: WorkspacesService) {}

  /**
   * Onboarding's Gmail step: save the daily limit for the mailbox connected via
   * Google OAuth. Never creates a mailbox; with `skip`, Gmail can be connected
   * later from Integrations.
   */
  async saveOnboardingLimit(
    workspaceId: string,
    dailyLimit: number,
    opts: { skip?: boolean } = {},
  ): Promise<{ gmail: { email: string; dailyLimit: number } | null }> {
    const clampedLimit = Math.min(150, Math.max(20, Number(dailyLimit) || 50));

    const mailbox = await withWorkspace(workspaceId, async (db) => {
      const acct = await sendableMailboxes(db, workspaceId).select(['id', 'email']).executeTakeFirst();
      if (!acct) return null;
      await db
        .updateTable('email_accounts')
        .set({ daily_limit: clampedLimit })
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', acct.id)
        .execute();
      return acct;
    });

    if (!mailbox && !opts.skip) {
      throw new BadRequestException('Connect your Gmail account first, or skip this step for now.');
    }

    await this.workspaces.updateOnboardingStep(workspaceId, 4);

    return { gmail: mailbox ? { email: mailbox.email, dailyLimit: clampedLimit } : null };
  }

  /** The workspace's connected sending mailbox (credentials present), if any. */
  async getForWorkspace(workspaceId: string): Promise<any> {
    return withWorkspace(workspaceId, (db) =>
      sendableMailboxes(db, workspaceId)
        .select(['id', 'email', 'provider', 'daily_limit', 'status', 'spf_status', 'dkim_status', 'dmarc_status'])
        .executeTakeFirst(),
    );
  }
}
