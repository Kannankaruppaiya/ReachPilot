/**
 * How a LinkedIn session is stored, restored, and (crucially) NOT overwritten.
 *
 * A LinkedIn session is a SET of cookies, and the authoritative copy of it lives
 * in the account's persistent browser profile — not in our vault. What we keep in
 * the vault is a SEED: enough to bring a brand-new profile back to life (a fresh
 * machine, or after Windows cleared %TEMP%). Treating the vault copy as the
 * authority is what let a stale cookie destroy a working session.
 *
 * These functions are pure so the policy is testable without launching a browser
 * (see `test/session-cookie-handling.spec.ts`).
 */

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

/**
 * Decode whatever the vault holds for an account.
 *
 * Accounts connected before the jar existed have a bare `li_at` string stored.
 * Those must keep working: signing every existing account out to fix a bug would
 * be a worse outage than the bug.
 */
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
 * Decide what to put into a freshly-opened browser context.
 *
 * The rule is one line, and it is the whole fix: **if the profile is already
 * signed in, leave it alone.** The profile's cookie is by definition at least as
 * fresh as the vault's — it is what LinkedIn last handed this browser — whereas
 * the vault's was captured at the last login and never updated since.
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
 * Read WHICH code LinkedIn wants before typing one.
 *
 * A stored TOTP seed can only answer the authenticator challenge. Typing that
 * code into an email or SMS challenge submits a wrong PIN — a failed login
 * attempt, which is exactly the signal that gets an account challenged harder.
 * So an unfamiliar wording returns `unknown` and the caller must stop rather
 * than guess; LinkedIn rewords these pages often.
 *
 * Email and SMS are matched FIRST: those pages routinely offer "use your
 * authenticator app instead" as an alternative link, so the mere presence of the
 * word "authenticator" does not mean the app code is what is being asked for.
 */
export function classifyPinChallenge(pageText: string): PinChallenge {
  const t = (pageText || '').trim();
  if (!t) return 'unknown';

  if (/to your email|code to\s+\S*@|sent .{0,40}to .{0,30}\S+@/i.test(t)) return 'email';
  if (/to your phone|text message|\bsms\b|ending in\s*\d/i.test(t)) return 'sms';
  if (/authenticat(?:or|ion) app|authenticator/i.test(t)) return 'totp';

  return 'unknown';
}
