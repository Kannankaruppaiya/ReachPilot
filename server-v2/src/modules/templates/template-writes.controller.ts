import { BadRequestException, Body, Controller, Delete, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { TemplateWritesService } from './template-writes.service';
import { JwtPayload } from '@/common/auth.guard';

// Re-exported so the module can wire both halves from one import.
export { TemplateWritesService };

const scope = (req: Request) => {
  const user = (req as any).user as JwtPayload;
  return { user, workspaceId: (req as any).workspaceId || user.workspaceId };
};

@Controller('api/templates')
export class TemplateWritesController {
  constructor(private readonly writes: TemplateWritesService) {}

  @Post()
  async create(
    @Body() body: { name?: string; channel?: string; subject?: string; body?: string },
    @Req() req: Request,
  ) {
    const { user, workspaceId } = scope(req);
    const text = String(body.body ?? '').trim();
    if (!text) throw new BadRequestException('Template body is required');
    if (body.channel !== 'linkedin' && body.channel !== 'email') {
      throw new BadRequestException('channel must be linkedin or email');
    }
    return this.writes.create(workspaceId, user.sub, {
      name: String(body.name ?? '').trim() || text.slice(0, 40),
      channel: body.channel,
      subject: body.subject?.trim() || null,
      body: text,
    });
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('Invalid template id');
    return { deleted: await this.writes.remove(scope(req).workspaceId, id) };
  }
}
