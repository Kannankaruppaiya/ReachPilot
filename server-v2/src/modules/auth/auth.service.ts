import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { AuditService } from '@/modules/audit/audit.service';
import { JwtPayload } from '@/common/auth.guard';

@Injectable()
export class AuthService {
  constructor(private readonly audit: AuditService) {}

  async signup(
    email: string,
    password: string,
    fullName: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<{ accessToken: string; refreshToken: string; workspaceId: string; userId: string }> {
    const db = getDb();
    const existing = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email.toLowerCase())
      .executeTakeFirst();

    if (existing) {
      throw new BadRequestException('An account with this email already exists.');
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    const user = await db
      .insertInto('users')
      .values({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        full_name: fullName,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const workspace = await db
      .insertInto('workspaces')
      .values({
        name: `${fullName}'s Workspace`,
        goal: 'Sales',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // memberships is RLS-scoped — insert under the new workspace's context.
    await withWorkspace(workspace.id, (wdb) =>
      wdb
        .insertInto('memberships')
        .values({ workspace_id: workspace.id, user_id: user.id, role: 'owner' })
        .execute(),
    );

    // Auto-login: issue a session so the user lands straight in the app.
    const tokens = await this.createSession(user.id, email.toLowerCase(), workspace.id, 'owner', meta);
    return { ...tokens, workspaceId: workspace.id, userId: user.id };
  }

  /**
   * Find the workspace a user belongs to. `memberships` is RLS-scoped and we
   * have no workspace context at login time, so we probe each workspace under
   * its own context. Fine for now; production should use a BYPASSRLS service
   * role or a denormalized lookup.
   */
  private async findMembership(
    userId: string,
  ): Promise<{ workspaceId: string; role: string } | null> {
    const db = getDb();
    const workspaces = await db.selectFrom('workspaces').select('id').execute();
    for (const ws of workspaces) {
      const m = await withWorkspace(ws.id, (d) =>
        d
          .selectFrom('memberships')
          .select(['role'])
          .where('user_id', '=', userId)
          .where('workspace_id', '=', ws.id)
          .executeTakeFirst(),
      );
      if (m) return { workspaceId: ws.id, role: m.role };
    }
    return null;
  }

  /** Current user's profile (for restoring a session on the frontend). */
  async getMe(userId: string, workspaceId: string): Promise<any> {
    const db = getDb();
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'full_name'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new UnauthorizedException('User not found.');
    const ws = await db
      .selectFrom('workspaces')
      .select(['name', 'onboarding_done'])
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      workspaceId,
      workspaceName: ws?.name || '',
      onboardingDone: ws?.onboarding_done ?? false,
    };
  }

  async login(
    email: string,
    password: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ accessToken: string; refreshToken: string; workspaceId: string }> {
    const db = getDb();
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email.toLowerCase())
      .executeTakeFirst();

    if (!user || !user.password_hash) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const valid = await argon2.verify(user.password_hash, password);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (user.disabled_at) {
      throw new UnauthorizedException('This account has been disabled.');
    }

    const membership = await this.findMembership(user.id);
    if (!membership) {
      throw new UnauthorizedException('No workspace found for this user.');
    }

    await db
      .updateTable('users')
      .set({ last_login_at: new Date().toISOString() })
      .where('id', '=', user.id)
      .execute();

    const tokens = await this.createSession(user.id, user.email, membership.workspaceId, membership.role, meta);

    await this.audit.log({
      userId: user.id,
      workspaceId: membership.workspaceId,
      action: 'user.login',
      ip: meta.ip,
    });

    return { ...tokens, workspaceId: membership.workspaceId };
  }

  async refresh(
    refreshToken: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const db = getDb();
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const session = await db
      .selectFrom('user_sessions')
      .selectAll()
      .where('refresh_token_hash', '=', tokenHash)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    if (new Date(session.expires_at) < new Date()) {
      throw new UnauthorizedException('Refresh token expired.');
    }

    await db
      .updateTable('user_sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('id', '=', session.id)
      .execute();

    const membership = await this.findMembership(session.user_id);

    const user = await db
      .selectFrom('users')
      .select(['id', 'email'])
      .where('id', '=', session.user_id)
      .executeTakeFirstOrThrow();

    return this.createSession(
      user.id,
      user.email,
      membership?.workspaceId || '',
      membership?.role || 'member',
      meta,
    );
  }

  async logout(refreshToken: string): Promise<void> {
    const db = getDb();
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    await db
      .updateTable('user_sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('refresh_token_hash', '=', tokenHash)
      .execute();
  }

  async forgotPassword(email: string): Promise<void> {
    const db = getDb();
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email.toLowerCase())
      .executeTakeFirst();

    if (!user) return;

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await db
      .insertInto('password_reset_tokens')
      .values({
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      })
      .execute();
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const db = getDb();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const resetToken = await db
      .selectFrom('password_reset_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('used_at', 'is', null)
      .executeTakeFirst();

    if (!resetToken || new Date(resetToken.expires_at) < new Date()) {
      throw new BadRequestException('Invalid or expired reset token.');
    }

    const passwordHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    await db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', resetToken.user_id)
      .execute();

    await db
      .updateTable('password_reset_tokens')
      .set({ used_at: new Date().toISOString() })
      .where('id', '=', resetToken.id)
      .execute();
  }

  private async createSession(
    userId: string,
    email: string,
    workspaceId: string,
    role: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const env = getEnv();
    const db = getDb();

    const payload: JwtPayload = {
      sub: userId,
      email,
      workspaceId,
      role,
    };

    const accessToken = jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRY as any,
    });

    const refreshToken = crypto.randomBytes(40).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await db
      .insertInto('user_sessions')
      .values({
        user_id: userId,
        refresh_token_hash: refreshTokenHash,
        user_agent: meta.userAgent || null,
        ip: meta.ip || null,
        expires_at: expiresAt.toISOString(),
      })
      .execute();

    return { accessToken, refreshToken };
  }

  /**
   * Ensures the dev bypass user and workspace exist.
   * Called once on startup when AUTH_BYPASS=true.
   */
  async ensureBypassUser(): Promise<void> {
    const db = getDb();
    const userId = '00000000-0000-0000-0000-000000000001';
    const workspaceId = '00000000-0000-0000-0000-000000000010';

    const existingUser = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst();

    if (existingUser) return;

    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev@reachpilot.dev',
        full_name: 'Dev User',
        email_verified_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        name: '',
        goal: 'Sales',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('memberships')
      .values({
        workspace_id: workspaceId,
        user_id: userId,
        role: 'owner',
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'user_id']).doNothing())
      .execute();
  }
}
