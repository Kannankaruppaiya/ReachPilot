import { Controller, Get, Post, Body, Req } from '@nestjs/common';
import { Request } from 'express';
import { BillingService } from './billing.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  async getPlans() {
    return this.billing.getPlans();
  }

  @Get('subscription')
  async getSubscription(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.billing.getSubscription(workspaceId);
  }

  @Post('subscription')
  async updateSubscription(
    @Body() body: { planId?: string },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.billing.createSubscription(workspaceId, body.planId || 'pro');
  }
}
