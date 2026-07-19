import { Controller, Post, Get, Patch, Body, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { LinkedinAccountsService } from './linkedin-accounts.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/linkedin')
export class LinkedinAccountsController {
  constructor(private readonly linkedin: LinkedinAccountsService) {}

  /** Live LinkedIn account + warm-up state for the app shell. */
  @Get()
  async get(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    return this.linkedin.getAccountState(user.workspaceId);
  }

  /**
   * Save LinkedIn limits — the single place limits are controlled (Settings →
   * LinkedIn limits). The pacing engine enforces exactly what's stored here.
   */
  @Patch('limits')
  async updateLimits(
    @Body() body: { dailyLimit?: number; weeklyInviteCap?: number },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    if (body?.dailyLimit == null || body?.weeklyInviteCap == null) {
      throw new BadRequestException('dailyLimit and weeklyInviteCap are required.');
    }
    return this.linkedin.updateLimits(user.workspaceId, body.dailyLimit, body.weeklyInviteCap);
  }

  @Post('connect')
  async connect(
    @Body() body: { email?: string; password?: string; country?: string },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const { email, password, country } = body || {};

    if (!email || !password || !country) {
      throw new BadRequestException('Email, password, and country are required.');
    }

    const result = await this.linkedin.connect(
      user.workspaceId,
      user.sub,
      email,
      password,
      country,
    );

    return {
      ok: true,
      dedicatedIp: result.dedicatedIp,
      country: result.country,
    };
  }

  @Post('2fa/verify')
  async verify2fa(@Body() body: { secret?: string }, @Req() req: Request) {
    const workspaceId = (req as any).workspaceId || '00000000-0000-0000-0000-000000000010';
    const secret = body.secret;
    if (!secret) {
      throw new BadRequestException('2FA verification secret is required.');
    }
    const result = await this.linkedin.verifyTwoFa(workspaceId, secret);
    return {
      ok: true,
      status: result.status,
    };
  }

  @Post('2fa/skip')
  async skip2fa(@Req() req: Request) {
    const workspaceId = (req as any).workspaceId || '00000000-0000-0000-0000-000000000010';
    const result = await this.linkedin.skipTwoFa(workspaceId);
    return {
      ok: true,
      status: result.status,
    };
  }
}
