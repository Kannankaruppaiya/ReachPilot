import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { getEnv } from '@/config/env';
import { getDb } from '@/db';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface JwtPayload {
  sub: string;
  email: string;
  workspaceId: string;
  role: string;
  iat?: number;
  exp?: number;
}

/**
 * Guard that validates JWT access tokens from the Authorization header.
 * Also supports API key auth via X-API-Key header.
 * Routes decorated with @Public() bypass authentication.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const env = getEnv();

    if (env.AUTH_BYPASS) {
      const request = context.switchToHttp().getRequest();
      request.user = {
        sub: '00000000-0000-0000-0000-000000000001',
        email: 'dev@reachpilot.dev',
        workspaceId: '00000000-0000-0000-0000-000000000010',
        role: 'owner',
      } satisfies JwtPayload;
      return true;
    }

    const request = context.switchToHttp().getRequest();

    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      return this.validateApiKey(apiKey, request);
    }

    const authHeader = request.headers['authorization'] as string | undefined;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization header.');
    }

    const token = authHeader.substring(7);
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token.');
    }
  }

  private async validateApiKey(key: string, request: any): Promise<boolean> {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const db = getDb();
    const row = await db
      .selectFrom('api_keys')
      .selectAll()
      .where('key_hash', '=', hash)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (!row) {
      throw new UnauthorizedException('Invalid API key.');
    }

    await db
      .updateTable('api_keys')
      .set({ last_used_at: new Date().toISOString() })
      .where('id', '=', row.id)
      .execute();

    request.user = {
      sub: row.created_by || '00000000-0000-0000-0000-000000000000',
      email: '',
      workspaceId: row.workspace_id,
      role: 'member',
    } satisfies JwtPayload;

    return true;
  }
}
