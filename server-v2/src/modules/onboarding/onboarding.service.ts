import { Injectable } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { LinkedinAccountsService } from '@/modules/accounts/linkedin-accounts.service';
import { EmailAccountsService } from '@/modules/accounts/email-accounts.service';

@Injectable()
export class OnboardingService {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly linkedin: LinkedinAccountsService,
    private readonly email: EmailAccountsService,
  ) {}

  async getOnboardingState(workspaceId: string): Promise<any> {
    const ws = await this.workspaces.getWorkspace(workspaceId);
    const li = await this.linkedin.getForWorkspace(workspaceId);
    const em = await this.email.getForWorkspace(workspaceId);

    const [leadCountRes, firstLead] = await withWorkspace(workspaceId, async (db) => {
      const countRes = await db
        .selectFrom('leads')
        .select((eb: any) => eb.fn.count('id').as('cnt'))
        .executeTakeFirst() as any;

      const lead = await db
        .selectFrom('leads')
        .select('source')
        .limit(1)
        .executeTakeFirst();

      return [countRes, lead];
    });

    return {
      workspace: ws ? { name: ws.name, goal: ws.goal } : null,
      linkedin: li
        ? { email: li.email, country: li.country, dedicatedIp: li.proxy_ip || '0.0.0.0' }
        : null,
      twofa: { status: li ? li.twofa || 'not_set' : 'not_set' },
      gmail: em ? { email: em.email, dailyLimit: em.daily_limit } : null,
      warmup: li
        ? {
            dailyLimit: li.warmup_daily_limit,
            hoursStart: li.hours_start?.substring(0, 5) || '09:00',
            hoursEnd: li.hours_end?.substring(0, 5) || '18:00',
            weekends: li.send_weekends,
          }
        : null,
      leadCount: Number(leadCountRes?.cnt || 0),
      leadSource: firstLead?.source || null,
      completedStep: ws ? ws.onboarding_step : 0,
      onboardingDone: ws ? ws.onboarding_done : false,
    };
  }

  async saveWarmup(
    workspaceId: string,
    dailyLimit: number,
    hoursStart: string,
    hoursEnd: string,
    weekends: boolean,
  ): Promise<void> {
    await withWorkspace(workspaceId, (db) =>
      db
        .updateTable('linkedin_accounts')
        .set({ warmup_daily_limit: dailyLimit, hours_start: hoursStart, hours_end: hoursEnd, send_weekends: weekends })
        .execute(),
    );

    await this.workspaces.updateOnboardingStep(workspaceId, 5);
  }
}
