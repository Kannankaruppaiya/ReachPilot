import { Controller, Get, Post, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { Request } from 'express';
import { CampaignsService } from './campaigns.service';
import { JwtPayload } from '@/common/auth.guard';

@Controller('api/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  private ws(req: Request): string {
    const user = (req as any).user as JwtPayload;
    return (req as any).workspaceId || user.workspaceId;
  }

  @Get()
  async list(@Req() req: Request) {
    return this.campaigns.list(this.ws(req));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request) {
    return this.campaigns.get(this.ws(req), id);
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request) {
    return this.campaigns.create(this.ws(req), {
      name: body.name || '',
      dailyCap: body.dailyCap,
      steps: body.steps,
      leadIds: body.leadIds,
      launch: body.launch,
    });
  }

  @Post(':id/enroll')
  async enroll(@Param('id') id: string, @Body() body: { leadIds?: string[] }, @Req() req: Request) {
    return this.campaigns.enroll(this.ws(req), id, body.leadIds || [], 'active');
  }

  @Post(':id/launch')
  async launch(@Param('id') id: string, @Req() req: Request) {
    return this.campaigns.launch(this.ws(req), id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request) {
    return this.campaigns.update(this.ws(req), id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    return this.campaigns.remove(this.ws(req), id);
  }

  @Patch(':id/enrollments/:enrollmentId')
  async setEnrollment(
    @Param('id') id: string,
    @Param('enrollmentId') enrollmentId: string,
    @Body() body: { action?: 'pause' | 'resume' },
    @Req() req: Request,
  ) {
    return this.campaigns.setEnrollmentStatus(this.ws(req), id, enrollmentId, body.action || 'pause');
  }

  @Delete(':id/enrollments/:enrollmentId')
  async removeEnrollment(
    @Param('id') id: string,
    @Param('enrollmentId') enrollmentId: string,
    @Req() req: Request,
  ) {
    return this.campaigns.removeEnrollment(this.ws(req), id, enrollmentId);
  }
}
