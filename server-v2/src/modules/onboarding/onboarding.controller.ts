import { Controller, Get, Post, Body, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { OnboardingService } from './onboarding.service';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { LeadsService } from '@/modules/leads/leads.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly workspaces: WorkspacesService,
    private readonly leads: LeadsService,
  ) {}

  @Get('onboarding')
  async getOnboarding(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.onboarding.getOnboardingState(workspaceId);
  }

  @Post('warmup')
  async saveWarmup(
    @Body()
    body: {
      dailyLimit?: number;
      hoursStart?: string;
      hoursEnd?: string;
      weekends?: boolean;
    },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    const limit = Number(body.dailyLimit);

    if (!limit || limit < 1 || limit > 45) {
      throw new BadRequestException('Daily connection limit must be between 1 and 45.');
    }

    await this.onboarding.saveWarmup(
      workspaceId,
      limit,
      body.hoursStart || '09:00',
      body.hoursEnd || '18:00',
      Boolean(body.weekends),
    );

    return { ok: true, warmup: body };
  }

  @Post('leads/import')
  async importLeads(
    @Body() body: { source?: string; url?: string; rows?: any[] },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;

    if (!body.source) {
      throw new BadRequestException('Pick a lead source.');
    }

    const rows = body.rows || [];
    const result = await this.leads.importLeads(workspaceId, body.source, rows);
    await this.workspaces.updateOnboardingStep(workspaceId, 6);

    return {
      ok: true,
      count: result.count,
      source: body.source,
    };
  }

  @Post('onboarding/complete')
  async complete(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    await this.workspaces.completeOnboarding(workspaceId);
    return {
      ok: true,
      message: 'Workspace ready! Welcome to ReachPilot.',
    };
  }

  @Post('onboarding/reset')
  async reset(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    await this.workspaces.resetOnboarding(workspaceId);
    return { ok: true };
  }
}
