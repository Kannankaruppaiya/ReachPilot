import { Controller, Get, Post, Delete, Param, Body, Req } from '@nestjs/common';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  async list(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.webhooks.list(workspaceId);
  }

  @Post()
  async create(
    @Body() body: { url?: string; events?: string[] },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.webhooks.create(workspaceId, body.url || '', body.events || ['*']);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    await this.webhooks.remove(workspaceId, id);
    return { ok: true };
  }
}
