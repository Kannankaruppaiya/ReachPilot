import { Controller, Post, Get, Body, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { Public, JwtPayload } from '@/common/auth.guard';
import { RateLimit } from '@/common/rate-limiter.guard';
import { AuthService } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @RateLimit({ max: 20, windowMs: 60000, keyPrefix: 'rl:auth' })
  @Post('signup')
  async signup(
    @Body() body: { email?: string; password?: string; fullName?: string },
    @Req() req: Request,
  ) {
    const email = body.email?.trim();
    const password = body.password;
    const fullName = body.fullName?.trim();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('Enter a valid email address.');
    }
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters.');
    }
    if (!fullName) {
      throw new BadRequestException('Full name is required.');
    }

    const result = await this.authService.signup(email, password, fullName, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    return {
      ok: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      workspaceId: result.workspaceId,
    };
  }

  @Public()
  @RateLimit({ max: 20, windowMs: 60000, keyPrefix: 'rl:auth' })
  @Post('login')
  async login(@Body() body: { email?: string; password?: string }, @Req() req: Request) {
    const email = body.email?.trim();
    const password = body.password;

    if (!email || !password) {
      throw new BadRequestException('Email and password are required.');
    }

    const result = await this.authService.login(email, password, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    return {
      ok: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      workspaceId: result.workspaceId,
    };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    return this.authService.getMe(user.sub, user.workspaceId);
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() body: { refreshToken?: string }, @Req() req: Request) {
    if (!body.refreshToken) {
      return { error: 'Refresh token is required.' };
    }

    const result = await this.authService.refresh(body.refreshToken, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    return {
      ok: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  @Public()
  @Post('logout')
  async logout(@Body() body: { refreshToken?: string }) {
    if (body.refreshToken) {
      await this.authService.logout(body.refreshToken);
    }
    return { ok: true };
  }

  @Public()
  @Post('forgot')
  async forgot(@Body() body: { email?: string }) {
    if (body.email) {
      await this.authService.forgotPassword(body.email);
    }
    return { ok: true, message: 'If that email exists, a reset link has been sent.' };
  }

  @Public()
  @Post('reset')
  async reset(@Body() body: { token?: string; password?: string }) {
    if (!body.token || !body.password) {
      return { error: 'Token and new password are required.' };
    }
    if (body.password.length < 8) {
      return { error: 'Password must be at least 8 characters.' };
    }
    await this.authService.resetPassword(body.token, body.password);
    return { ok: true };
  }
}
