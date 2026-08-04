import { Controller, Get, Patch, Param, Body, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { LeadsService } from './leads.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  async list(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('source') source?: string,
    @Query('sort') sort?: string,
    @Query('scrapeJobId') scrapeJobId?: string,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.leads.list(workspaceId, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      q: q?.trim() || undefined,
      status: status?.trim() || undefined,
      source: source?.trim() || undefined,
      sort: sort === 'score' ? 'score' : 'recent',
      scrapeJobId: scrapeJobId?.trim() || undefined,
    });
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.leads.update(workspaceId, id, body);
  }
}
