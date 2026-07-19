import { Controller, Get, Post, Delete, Body, Param, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiKeysService } from './apikeys.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/apikeys')
export class ApiKeysController {
  constructor(private readonly apikeys: ApiKeysService) {}

  @Get()
  async list(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.apikeys.list(workspaceId);
  }

  @Post()
  async create(
    @Body() body: { name?: string; scopes?: string[] },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.apikeys.create(
      workspaceId,
      user.sub,
      body.name || '',
      body.scopes || ['read', 'write'],
    );
  }

  @Delete(':id')
  async revoke(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    await this.apikeys.revoke(workspaceId, id);
    return { ok: true };
  }
}
