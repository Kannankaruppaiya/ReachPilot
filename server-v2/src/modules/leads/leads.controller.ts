import { Controller, Get, Patch, Param, Body, Req } from '@nestjs/common';
import { Request } from 'express';
import { LeadsService } from './leads.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  async list(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.leads.list(workspaceId);
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
