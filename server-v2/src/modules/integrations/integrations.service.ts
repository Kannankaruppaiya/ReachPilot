import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { getEnv } from '@/config/env';
import { withWorkspace } from '@/db/rls';
import { SecretsService } from '@/modules/vault/secrets.service';
import { ApifyMcpService } from '@/modules/ai/apify-mcp.service';
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
    private readonly apifyMcp: ApifyMcpService,
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
      // All Gmail mailboxes — the email warm-up loop pairs them, so the page
      // must show and allow connecting more than one. Active rows first.
      const accounts = await db
        .selectFrom('email_accounts')
        .select(['email', 'provider', 'daily_limit', 'status', 'connected_at', 'spf_status', 'dkim_status', 'dmarc_status'])
        .where('provider', '=', 'gmail')
        .orderBy((eb) => eb.case().when('status', '=', 'active').then(0).else(1).end())
        .orderBy('connected_at', 'desc')
        .execute();
      const gmail = accounts[0];

      const others = await db
        .selectFrom('integrations')
        .select(['provider', 'active', 'created_at', 'config'])
        .execute();

      const apifyRow = others.find((i) => i.provider === 'apify' && i.active);
      const apifyConfig = apifyRow
        ? ((typeof apifyRow.config === 'string' ? JSON.parse(apifyRow.config) : apifyRow.config) as
            | { enabledTools?: string }
            | null)
        : null;

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
        gmailAccounts: accounts.map((a) => ({
          email: a.email,
          connected: a.status === 'active',
          status: a.status,
          connectedAt: a.connected_at,
        })),
        apify: apifyRow
          ? {
              connected: true,
              enabledTools: apifyConfig?.enabledTools || getEnv().APIFY_MCP_DEFAULT_TOOLS,
              connectedAt: apifyRow.created_at,
            }
          : { connected: false },
        integrations: others.map((i) => ({
          provider: i.provider,
          active: i.active,
          created_at: i.created_at,
        })),
      };
    });
  }

  /**
   * Connect Apify: validate the API token against the hosted MCP server, encrypt
   * it into the vault, and upsert the `integrations` row (provider='apify') with
   * the enabled tool set. The AI assistant then gets Apify's tools on its next
   * chat. Throws if the token can't reach Apify so the UI can reject it inline.
   */
  async connectApify(
    workspaceId: string,
    token: string,
    enabledTools?: string,
  ): Promise<{ connected: true; toolCount: number; enabledTools: string }> {
    const clean = (token || '').trim();
    if (!clean) throw new BadRequestException('An Apify API token is required.');
    const tools = (enabledTools || '').trim() || getEnv().APIFY_MCP_DEFAULT_TOOLS;

    // Validate before storing — a bad token or unreachable server fails here.
    const { toolCount } = await this.apifyMcp.verifyToken(clean, tools);

    const secretId = await this.secrets.encrypt(clean, 'integration_credentials', { workspaceId });

    await withWorkspace(workspaceId, async (db) => {
      const existing = await db
        .selectFrom('integrations')
        .select(['id', 'credentials_secret_id'])
        .where('provider', '=', 'apify')
        .executeTakeFirst();

      if (existing) {
        if (existing.credentials_secret_id) {
          await this.secrets.remove(existing.credentials_secret_id, workspaceId).catch(() => undefined);
        }
        await db
          .updateTable('integrations')
          .set({ active: true, credentials_secret_id: secretId, config: JSON.stringify({ enabledTools: tools }) })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await db
          .insertInto('integrations')
          .values({
            workspace_id: workspaceId,
            provider: 'apify',
            active: true,
            credentials_secret_id: secretId,
            config: JSON.stringify({ enabledTools: tools }),
          })
          .execute();
      }

      await db
        .insertInto('activity')
        .values({ workspace_id: workspaceId, text: `Apify connected — ${toolCount} tools available`, tone: 'success' })
        .execute();
    });

    this.logger.log(`Apify connected for workspace ${workspaceId}: ${toolCount} tools`);
    return { connected: true, toolCount, enabledTools: tools };
  }

  /** Disconnect Apify: drop the stored token and deactivate the integration. */
  async disconnectApify(workspaceId: string): Promise<{ ok: true }> {
    await withWorkspace(workspaceId, async (db) => {
      const row = await db
        .selectFrom('integrations')
        .select(['id', 'credentials_secret_id'])
        .where('provider', '=', 'apify')
        .executeTakeFirst();
      if (!row) return;

      if (row.credentials_secret_id) {
        await this.secrets.remove(row.credentials_secret_id, workspaceId).catch(() => undefined);
      }
      await db
        .updateTable('integrations')
        .set({ active: false, credentials_secret_id: null })
        .where('id', '=', row.id)
        .execute();
    });
    return { ok: true };
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
