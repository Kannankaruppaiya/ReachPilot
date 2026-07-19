import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { getDb } from '@/db';
import { getEnv } from '@/config/env';
import { withWorkspace } from '@/db/rls';
import { SecretsService } from '@/modules/vault/secrets.service';
import { GoogleOAuthService } from './google-oauth.service';

interface OAuthState {
  workspaceId: string;
  userId: string;
}

/**
 * Google/Gmail connection lifecycle. The Gmail mailbox is stored in
 * `email_accounts` (its refresh token encrypted in the vault) so the email
 * driver can send + the inbox-sync worker can read on the user's behalf.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly secrets: SecretsService,
  ) {}

  /** Build the Google consent URL, signing the workspace/user into `state`. */
  buildGoogleConnectUrl(workspaceId: string, userId: string): string {
    const env = getEnv();
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new BadRequestException('Google integration is not configured on the server.');
    }
    const state = jwt.sign({ workspaceId, userId } satisfies OAuthState, env.JWT_SECRET, {
      expiresIn: '10m',
    });
    return this.oauth.buildAuthUrl(state);
  }

  /** Handle Google's redirect: verify state, exchange code, store the mailbox. */
  async handleGoogleCallback(code: string, state: string): Promise<{ email: string }> {
    const env = getEnv();
    let decoded: OAuthState;
    try {
      decoded = jwt.verify(state, env.JWT_SECRET) as OAuthState;
    } catch {
      throw new BadRequestException('Invalid or expired OAuth state.');
    }
    const { workspaceId, userId } = decoded;

    const { refreshToken, accessToken } = await this.oauth.exchangeCode(code);
    if (!refreshToken) {
      // Happens if the user already granted before without offline access.
      throw new BadRequestException(
        'Google did not return a refresh token. Remove ReachPilot from your Google account permissions and reconnect.',
      );
    }
    if (!accessToken) throw new BadRequestException('Google did not return an access token.');

    const email = await this.oauth.getUserEmail(accessToken);

    // Encrypt the refresh token — this is the durable credential.
    const secretId = await this.secrets.encrypt(refreshToken, 'email_oauth', { workspaceId });

    await withWorkspace(workspaceId, async (db) => {
      const existing = await db
        .selectFrom('email_accounts')
        .select(['id', 'credentials_secret_id'])
        .where('email', '=', email)
        .executeTakeFirst();

      if (existing) {
        // Replace the old secret if there was one.
        if (existing.credentials_secret_id) {
          await this.secrets.remove(existing.credentials_secret_id, workspaceId).catch(() => undefined);
        }
        await db
          .updateTable('email_accounts')
          .set({
            provider: 'gmail',
            credentials_secret_id: secretId,
            status: 'active',
            connected_at: new Date().toISOString(),
          })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await db
          .insertInto('email_accounts')
          .values({
            workspace_id: workspaceId,
            owner_user_id: userId,
            provider: 'gmail',
            email,
            credentials_secret_id: secretId,
            status: 'active',
            connected_at: new Date().toISOString(),
          })
          .execute();
      }

      await db
        .insertInto('activity')
        .values({ workspace_id: workspaceId, text: `Gmail connected — ${email}`, tone: 'success' })
        .execute();
    });

    this.logger.log(`Gmail connected for workspace ${workspaceId}: ${email}`);
    return { email };
  }

  /** Integrations page data: mailbox connection + generic integrations. */
  async list(workspaceId: string): Promise<any> {
    return withWorkspace(workspaceId, async (db) => {
      const gmail = await db
        .selectFrom('email_accounts')
        .select(['email', 'provider', 'daily_limit', 'status', 'connected_at', 'spf_status', 'dkim_status', 'dmarc_status'])
        .where('provider', '=', 'gmail')
        .executeTakeFirst();

      const others = await db
        .selectFrom('integrations')
        .select(['provider', 'active', 'created_at'])
        .execute();

      return {
        gmail: gmail
          ? {
              connected: gmail.status === 'active',
              email: gmail.email,
              dailyLimit: gmail.daily_limit,
              status: gmail.status,
              connectedAt: gmail.connected_at,
            }
          : { connected: false },
        integrations: others,
      };
    });
  }

  /** Disconnect Gmail: revoke the token and drop the stored credential. */
  async disconnectGoogle(workspaceId: string): Promise<{ ok: true }> {
    await withWorkspace(workspaceId, async (db) => {
      const acct = await db
        .selectFrom('email_accounts')
        .select(['id', 'credentials_secret_id'])
        .where('provider', '=', 'gmail')
        .executeTakeFirst();
      if (!acct) return;

      if (acct.credentials_secret_id) {
        const refresh = await this.secrets
          .decrypt(acct.credentials_secret_id, { workspaceId })
          .catch(() => null);
        if (refresh) await this.oauth.revoke(refresh);
        await this.secrets.remove(acct.credentials_secret_id, workspaceId).catch(() => undefined);
      }

      await db
        .updateTable('email_accounts')
        .set({ status: 'disconnected', credentials_secret_id: null })
        .where('id', '=', acct.id)
        .execute();
    });
    return { ok: true };
  }
}
