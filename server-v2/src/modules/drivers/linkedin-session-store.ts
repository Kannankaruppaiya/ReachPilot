// How a LinkedIn session is stored and restored. The authoritative cookies live
// in the account's browser profile; the vault holds a seed for a fresh profile.
// Pure, so the policy is testable (test/session-cookie-handling.spec.ts).

/** The domain LinkedIn actually sets `li_at` on — not the broader `.linkedin.com`. */
export const LI_AT_DOMAIN = '.www.linkedin.com';

/** A cookie in the shape Playwright's `context.cookies()` / `addCookies()` use. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'None' | 'Strict';
}

/** Encode a captured jar for the vault. */
export function serializeSession(cookies: StoredCookie[]): string {
  return JSON.stringify(cookies);
}

/** Decode the vault value: a cookie jar, or a legacy bare `li_at` string (still supported). */
export function parseStoredSession(stored?: string | null): StoredCookie[] {
  const raw = (stored || '').trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((c: StoredCookie) => c && c.name && c.value);
    } catch {
      return [];
    }
  }

  // Legacy format: the value IS the li_at cookie.
  return [{ name: 'li_at', value: raw, domain: LI_AT_DOMAIN, path: '/' }];
}

/**
 * Cookies to inject into a new context: none if the profile is already signed in,
 * because its cookie is at least as fresh as the vault's.
 */
export function cookiesToInject(
  existing: StoredCookie[],
  stored: StoredCookie[],
): StoredCookie[] {
  const signedIn = existing.some((c) => c.name === 'li_at' && !!c.value);
  if (signedIn) return [];
  return stored;
}

/** Which second factor LinkedIn is asking for. */
export type PinChallenge = 'totp' | 'email' | 'sms' | 'unknown';

/**
 * Which code is LinkedIn asking for? A TOTP seed only answers the authenticator
 * challenge; a wrong PIN is a failed login. Unfamiliar wording → `unknown`, and
 * the caller stops. Email/SMS match first: those pages also mention the authenticator.
 */
export function classifyPinChallenge(pageText: string): PinChallenge {
  const t = (pageText || '').trim();
  if (!t) return 'unknown';

  if (/to your email|code to\s+\S*@|sent .{0,40}to .{0,30}\S+@/i.test(t)) return 'email';
  if (/to your phone|text message|\bsms\b|ending in\s*\d/i.test(t)) return 'sms';
  if (/authenticat(?:or|ion) app|authenticator/i.test(t)) return 'totp';

  return 'unknown';
}
