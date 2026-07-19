import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { TemplatesService } from './templates.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  async list(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.templates.list(workspaceId);
  }
}
