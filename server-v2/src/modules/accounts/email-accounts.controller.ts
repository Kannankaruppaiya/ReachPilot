import { Controller, Post, Body, Req } from '@nestjs/common';
import { Request } from 'express';
import { EmailAccountsService } from './email-accounts.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/gmail')
export class EmailAccountsController {
  constructor(private readonly email: EmailAccountsService) {}

  /**
   * Onboarding Gmail step: save the daily limit for the OAuth-connected mailbox.
   * `skip: true` finishes the step without one.
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
