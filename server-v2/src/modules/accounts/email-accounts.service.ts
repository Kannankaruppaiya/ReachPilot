import { Injectable, BadRequestException } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { SecretsService } from '@/modules/vault/secrets.service';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';

@Injectable()
export class EmailAccountsService {
  constructor(
    private readonly secrets: SecretsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async connectGmail(
    workspaceId: string,
    userId: string,
    dailyLimit: number,
  ): Promise<{ gmail: { email: string; dailyLimit: number } }> {
    const clampedLimit = Math.min(150, Math.max(20, Number(dailyLimit) || 50));
    const email = 'study@rjpinfotek.com';

    await withWorkspace(workspaceId, async (db) => {
      const existing = await db
        .selectFrom('email_accounts')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable('email_accounts')
          .set({ daily_limit: clampedLimit, status: 'active', connected_at: new Date().toISOString() })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await db
          .insertInto('email_accounts')
          .values({
            workspace_id: workspaceId,
            owner_user_id: userId,
            provider: 'gmail',
            email,
            daily_limit: clampedLimit,
            status: 'active',
            connected_at: new Date().toISOString(),
          })
          .execute();
      }
    });

    await this.workspaces.updateOnboardingStep(workspaceId, 4);

    return { gmail: { email, dailyLimit: clampedLimit } };
  }

  async getForWorkspace(workspaceId: string): Promise<any> {
    return withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('email_accounts')
        .select(['id', 'email', 'provider', 'daily_limit', 'status', 'spf_status', 'dkim_status', 'dmarc_status'])
        .executeTakeFirst(),
    );
  }
}
