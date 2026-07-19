import { Controller, Post, Body, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { WorkspacesService } from './workspaces.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post('workspace')
  async createWorkspace(@Body() body: { name?: string; goal?: string }, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const name = body.name?.trim();
    if (!name) {
      throw new BadRequestException('Workspace name is required.');
    }

    const workspaceId = user.workspaceId;

    const ws = await this.workspaces.updateWorkspace(workspaceId, {
      name,
      goal: body.goal || 'Sales',
    });

    await this.workspaces.updateOnboardingStep(workspaceId, 1);

    return {
      ok: true,
      workspace: {
        name: ws.name,
        goal: ws.goal,
        createdAt: ws.created_at,
      },
    };
  }
}
