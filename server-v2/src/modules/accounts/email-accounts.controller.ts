import { Controller, Post, Body, Req } from '@nestjs/common';
import { Request } from 'express';
import { EmailAccountsService } from './email-accounts.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/gmail')
export class EmailAccountsController {
  constructor(private readonly email: EmailAccountsService) {}

  @Post('connect')
  async connect(@Body() body: { dailyLimit?: number }, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    const dailyLimit = Number(body.dailyLimit) || 50;

    const result = await this.email.connectGmail(workspaceId, user.sub, dailyLimit);
    return {
      ok: true,
      gmail: result.gmail,
    };
  }
}
