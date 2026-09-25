import { Controller, Post, Body, Req } from '@nestjs/common';
import { Request } from 'express';
import { EmailAccountsService } from './email-accounts.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/gmail')
export class EmailAccountsController {
  constructor(private readonly email: EmailAccountsService) {}

  /**
   * Onboarding Gmail step. The mailbox itself is connected through Google OAuth
   * (/api/integrations/google/connect); this saves its daily limit and marks the
   * step done. `skip: true` finishes the step with no mailbox connected.
   */
  @Post('connect')
  async connect(@Body() body: { dailyLimit?: number; skip?: boolean }, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    const dailyLimit = Number(body.dailyLimit) || 50;

    const result = await this.email.saveOnboardingLimit(workspaceId, dailyLimit, { skip: !!body.skip });
    return {
      ok: true,
      gmail: result.gmail,
    };
  }
}
