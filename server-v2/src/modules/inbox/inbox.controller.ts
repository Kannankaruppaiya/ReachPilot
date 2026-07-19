import { Controller, Get, Post, Param, Body, Req } from '@nestjs/common';
import { Request } from 'express';
import { InboxService } from './inbox.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/threads')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  async list(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.inbox.listThreads(workspaceId);
  }

  @Post(':id/messages')
  async sendMessage(
    @Param('id') id: string,
    @Body() body: { text?: string },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.inbox.sendMessage(workspaceId, id, body.text || '');
  }
}
