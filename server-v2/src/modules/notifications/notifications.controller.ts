import { Controller, Get, Patch, Param, Req, Sse } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { NotificationsService } from './notifications.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  async list(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.notifications.list(workspaceId);
  }

  @Patch('notifications/:id/read')
  async markRead(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    await this.notifications.markAsRead(workspaceId, id);
    return { ok: true };
  }

  @Sse('events')
  events(@Req() req: Request): Observable<{ data: string }> {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user?.workspaceId || '00000000-0000-0000-0000-000000000010';
    return this.notifications.getEventStream(workspaceId);
  }
}
