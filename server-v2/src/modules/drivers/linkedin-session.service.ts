import { Injectable, Logger } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { parseStoredSession } from './linkedin-session-store';
import { getEnv } from '@/config/env';
import { SecretsService } from '@/modules/vault/secrets.service';
import {
  LinkedInActionContext,
  LinkedInLoginContext,
  LinkedInFingerprint,
  ProxyConfig,
} from './linkedin-driver.interface';

/** Country → (timezone, locale) so the browser matches the proxy geography. */
const GEO: Record<string, { tz: string; locale: string }> = {
  IN: { tz: 'Asia/Kolkata', locale: 'en-IN' },
  US: { tz: 'America/New_York', locale: 'en-US' },
  DE: { tz: 'Europe/Berlin', locale: 'de-DE' },
  GB: { tz: 'Europe/London', locale: 'en-GB' },
};

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

/**
 * Turns a stored linkedin_accounts row into the concrete context a driver
 * needs — decrypting the session cookie / password / TOTP seed via the vault,
 * and pinning a geo-consistent fingerprint + proxy.
 */
@Injectable()
export class LinkedInSessionService {
  private readonly logger = new Logger(LinkedInSessionService.name);

  constructor(private readonly secrets: SecretsService) {}

  /** Stable fingerprint seeded by accountId so a given account always looks the same. */
  private fingerprintFor(accountId: string, country: string, timezone?: string): LinkedInFingerprint {
    const geo = GEO[(country || '').toUpperCase().slice(0, 2)] || { tz: timezone || 'UTC', locale: 'en-US' };
    const seed = [...accountId].reduce((a, c) => a + c.charCodeAt(0), 0);
    return {
      userAgent: UA_POOL[seed % UA_POOL.length],
      locale: geo.locale,
      timezoneId: timezone || geo.tz,
      viewport: { width: 1366, height: 768 },
    };
  }

  /** Build a proxy config from the account's assigned proxy + env credentials. */
  private proxyFor(proxy?: { ip?: string | null; provider?: string | null }): ProxyConfig | undefined {
    const env = getEnv();
    // Preferred: a provider gateway (e.g. Bright Data / IPRoyal) via env.
    if (env.PROXY_SERVER) {
      return {
        server: env.PROXY_SERVER,
        username: env.PROXY_USERNAME || undefined,
        password: env.PROXY_PASSWORD || undefined,
        ip: proxy?.ip || undefined,
      };
    }
    // 'local' = the machine's own IP (worker runs here) → direct egress, no
    // routing. 'simulator' = fake dev seed IP → never route through it either.
    // The account still records the IP for display/tracking.
    if (!proxy?.ip || proxy.provider === 'local' || proxy.provider === 'simulator') return undefined;
    // A real per-account residential proxy: route through host:port.
    const server = /:\d+$/.test(proxy.ip) ? proxy.ip : `${proxy.ip}:8000`;
    return { server, ip: proxy.ip };
  }

  private async loadAccount(accountId: string, workspaceId?: string) {
    const query = (db: any) =>
      db
        .selectFrom('linkedin_accounts')
        .leftJoin('proxies', 'proxies.id', 'linkedin_accounts.proxy_id')
        .select([
          'linkedin_accounts.id as id',
          'linkedin_accounts.workspace_id as workspace_id',
          'linkedin_accounts.email as email',
          'linkedin_accounts.country as country',
          'linkedin_accounts.timezone as timezone',
          'linkedin_accounts.status as status',
          'linkedin_accounts.session_secret_id as session_secret_id',
          'linkedin_accounts.password_secret_id as password_secret_id',
          'linkedin_accounts.totp_secret_id as totp_secret_id',
          'proxies.ip as proxy_ip',
          'proxies.provider as proxy_provider',
        ])
        .where('linkedin_accounts.id', '=', accountId)
        .executeTakeFirst();
    // linkedin_accounts is RLS-scoped — read under the workspace context.
    return workspaceId ? withWorkspace(workspaceId, query) : query(getDb());
  }

  /** Context for performing an action AS the account (needs a stored session cookie). */
  async buildActionContext(
    accountId: string,
    workspaceId?: string,
  ): Promise<LinkedInActionContext | null> {
    if (!accountId) return null;
    const acct = await this.loadAccount(accountId, workspaceId);
    if (!acct) return null;

    // Defense-in-depth (the scheduler already gates on this): never build an
    // action context for a flagged/paused account. Returning null makes the
    // worker treat it as "not sendable" rather than driving a browser at
    // LinkedIn with an account it has just challenged.
    if (['checkpoint', 'paused', 'disconnected'].includes(acct.status as string)) {
      this.logger.warn({ accountId, status: acct.status }, 'Refusing to act on non-sendable account');
      return null;
    }

    let secret: string | undefined;
    if (acct.session_secret_id) {
      secret = await this.secrets
        .decrypt(acct.session_secret_id, { workspaceId: acct.workspace_id })
        .catch(() => undefined);
    }
    // The vault may hold either the full jar (current) or a bare li_at (accounts
    // connected before the jar existed) — `parseStoredSession` normalises both.
    // `li_at` is still populated because the desktop-agent wire and older bundles
    // read that field.
    const cookies = parseStoredSession(secret);
    const li_at = cookies.find((c) => c.name === 'li_at')?.value;

    return {
      accountId: acct.id,
      workspaceId: acct.workspace_id,
      li_at,
      cookies,
      proxy: this.proxyFor({ ip: acct.proxy_ip as string | null, provider: (acct as any).proxy_provider }),
      fingerprint: this.fingerprintFor(acct.id, acct.country, acct.timezone),
    };
  }

  /** Context for the one-time login that captures the session cookie. */
  async buildLoginContext(
    accountId: string,
    workspaceId?: string,
  ): Promise<LinkedInLoginContext | null> {
    if (!accountId) return null;
    const acct = await this.loadAccount(accountId, workspaceId);
    if (!acct || !acct.password_secret_id) return null;

    const password = await this.secrets.decrypt(acct.password_secret_id, {
      workspaceId: acct.workspace_id,
    });
    let totpSecret: string | undefined;
    if (acct.totp_secret_id) {
      totpSecret = await this.secrets
        .decrypt(acct.totp_secret_id, { workspaceId: acct.workspace_id })
        .catch(() => undefined);
    }

    return {
      accountId: acct.id,
      workspaceId: acct.workspace_id,
      email: acct.email,
      password,
      totpSecret,
      proxy: this.proxyFor({ ip: acct.proxy_ip as string | null, provider: (acct as any).proxy_provider }),
      fingerprint: this.fingerprintFor(acct.id, acct.country, acct.timezone),
    };
  }
}
