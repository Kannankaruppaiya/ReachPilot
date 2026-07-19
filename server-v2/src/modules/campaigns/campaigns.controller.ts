import { Controller, Get, Post, Patch, Param, Body, Req, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { CampaignsService } from './campaigns.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  async list(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.campaigns.list(workspaceId);
  }

  @Post()
  async create(@Body() body: { name?: string; dailyCap?: number }, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.campaigns.create(workspaceId, body.name || '', body.dailyCap || 15);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.campaigns.update(workspaceId, id, body);
  }
}
