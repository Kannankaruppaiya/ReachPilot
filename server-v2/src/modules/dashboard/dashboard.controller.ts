import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { DashboardService } from './dashboard.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  async getDashboard(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.dashboard.getDashboardData(workspaceId);
  }
}
