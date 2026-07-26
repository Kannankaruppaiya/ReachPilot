import { Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { getEnv } from '@/config/env';

/**
 * Gmail scopes: send email, read replies (inbox sync), read the address, and
 * modify labels — the warm-up loop marks warm-up mail read/starred and moves
 * it out of spam, which needs gmail.modify. Mailboxes connected BEFORE this
 * scope was added must be re-connected once to grant it.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
];

/**
 * Thin wrapper around Google's OAuth2 + Gmail REST API.
 * Holds no per-user state — every call takes the token it needs.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  private client(): OAuth2Client {
    const env = getEnv();
    return new OAuth2Client({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_INTEGRATION_CALLBACK_URL,
    });
  }

  /** Consent-screen URL. `state` carries the signed workspace/user context. */
  buildAuthUrl(state: string): string {
    return this.client().generateAuthUrl({
      access_type: 'offline', // ← required to receive a refresh_token
      prompt: 'consent', // ← force refresh_token even on re-connect
      scope: GMAIL_SCOPES,
      state,
      include_granted_scopes: true,
    });
  }

  /** Exchange the authorization code for tokens (incl. the refresh_token). */
  async exchangeCode(code: string): Promise<{ refreshToken?: string; accessToken?: string }> {
    const { tokens } = await this.client().getToken(code);
    return {
      refreshToken: tokens.refresh_token || undefined,
      accessToken: tokens.access_token || undefined,
    };
  }

  /** Mint a fresh access token from a stored refresh token. */
  async accessTokenFromRefresh(refreshToken: string): Promise<string> {
    const client = this.client();
    client.setCredentials({ refresh_token: refreshToken });
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to obtain access token from refresh token');
    return token;
  }

  /** The connected mailbox address. */
  async getUserEmail(accessToken: string): Promise<string> {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
    const data: any = await res.json();
    return data.email;
  }

  /** Revoke access when the user disconnects. */
  async revoke(refreshToken: string): Promise<void> {
    try {
      await this.client().revokeToken(refreshToken);
    } catch (e: any) {
      this.logger.warn(`Token revoke failed (already revoked?): ${e.message}`);
    }
  }
}
