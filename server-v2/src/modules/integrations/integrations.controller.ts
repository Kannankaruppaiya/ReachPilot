import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { IntegrationsService } from './integrations.service';
import { JwtPayload, Public } from '@/common';
import { getEnv } from '@/config/env';

interface ApifyConnectBody {
  token?: string;
  enabledTools?: string;
}

@Controller('api/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  /** List connected integrations for the Integrations page. */
  @Get()
  async list(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.integrations.list(workspaceId);
  }

  /** Returns the Google consent URL for the frontend to open. */
  @Get('google/connect')
  async connect(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    const url = this.integrations.buildGoogleConnectUrl(workspaceId, user.sub);
    return { url };
  }

  /**
   * Google's OAuth redirect target. Public — the browser arrives here from
   * Google with no app JWT; the workspace is carried in the signed `state`.
   */
  @Public()
  @Get('google/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const appUrl = getEnv().APP_URL;
    if (error || !code || !state) {
      return res.redirect(`${appUrl}/?gmail=error`);
    }
    try {
      await this.integrations.handleGoogleCallback(code, state);
      return res.redirect(`${appUrl}/?gmail=connected`);
    } catch (e: any) {
      return res.redirect(`${appUrl}/?gmail=error&reason=${encodeURIComponent(e.message || 'failed')}`);
    }
  }

  /** Disconnect Gmail. */
  @Post('google/disconnect')
  async disconnect(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.integrations.disconnectGoogle(workspaceId);
  }

  /** Connect Apify: store the API token (validated against the MCP server first). */
  @Post('apify/connect')
  async connectApify(@Body() body: ApifyConnectBody, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.integrations.connectApify(workspaceId, body?.token || '', body?.enabledTools);
  }

  /** Disconnect Apify. */
  @Post('apify/disconnect')
  async disconnectApify(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.integrations.disconnectApify(workspaceId);
  }
}
