import { Controller, Get, Post, Delete, Body, Req, Query, Param } from '@nestjs/common';
import { Request } from 'express';
import { JobsService } from './jobs.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/send')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('create')
  async create(
    @Body()
    body: {
      kind?: 'linkedin' | 'email';
      cap?: number;
      rows?: any[];
      template?: string;
      subject?: string;
      useAi?: boolean;
      useApify?: boolean;
      aiGuidance?: string;
      noNote?: boolean;
    },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;

    return this.jobs.createBatch(
      workspaceId,
      body.kind || 'linkedin',
      body.cap || 15,
      body.rows || [],
      body.template || '',
      body.subject || '',
      {
        useAi: !!body.useAi,
        useApify: !!body.useApify,
        aiGuidance: body.aiGuidance || '',
        noNote: !!body.noNote,
      },
    );
  }

  @Get('jobs')
  async list(
    @Req() req: Request,
    @Query('kind') kind?: string,
    @Query('batchId') batchId?: string,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.jobs.listJobs(workspaceId, kind, batchId);
  }

  /**
   * Every LinkedIn connection request ever sent from this workspace, with live
   * delivery + acceptance/reply outcome. Backs the "Connections" page.
   */
  @Get('connections')
  async connections(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.jobs.listConnections(workspaceId);
  }

  /** Cancel one not-yet-sent job (the queue "close" button). */
  @Post('jobs/:id/cancel')
  async cancelJob(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.jobs.cancelJob(workspaceId, id);
  }

  /** Bulk-delete jobs — clear the queue or wipe for a fresh test.
   *  Body: { statuses?: string[]; kind?: string }. Empty body clears everything. */
  @Post('jobs/clear')
  async clearJobs(
    @Body() body: { statuses?: string[]; kind?: string },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.jobs.deleteJobs(workspaceId, { statuses: body?.statuses, kind: body?.kind });
  }

  /** Delete one job (the queue "delete" button). */
  @Delete('jobs/:id')
  async deleteJob(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.jobs.deleteJobs(workspaceId, { id });
  }
}
