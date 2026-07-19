import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { AnalyticsService } from './analytics.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('daily')
  async getDaily(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.analytics.getDailyStats(workspaceId);
  }

  @Get('hourly')
  async getHourly(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.analytics.getHourlyHeatmap(workspaceId);
  }

  @Get('channels')
  async getChannels(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.analytics.getChannelComparison(workspaceId);
  }
}
