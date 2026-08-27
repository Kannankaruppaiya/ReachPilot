/**
 * Which of LinkedIn's two sign-in pages are we looking at?
 *
 * We run each account in a persistent browser profile on purpose: a device
 * LinkedIn recognises is challenged far less often. The cost is that a
 * recognised device is served a DIFFERENT login page — "Welcome back", the
 * account's name and a masked email, and a password field only. There is no
 * username input on it at all, so the driver's usual "type the email first" step
 * waits on a selector that will never appear and then throws.
 *
 * Pure, so the policy is testable without a browser.
 */

export type LoginFormVariant = 'full' | 'remembered' | 'unknown';

export function classifyLoginForm(fields: {
  hasUsernameField: boolean;
  hasPasswordField: boolean;
}): LoginFormVariant {
  if (fields.hasUsernameField && fields.hasPasswordField) return 'full';
  if (fields.hasPasswordField) return 'remembered';
  return 'unknown';
}

/**
 * Does the account LinkedIn remembers on this profile match the one we hold
 * credentials for?
 *
 * The remembered page shows the address masked — `g*****@gmail.com` — so an
 * exact comparison is impossible. What it does reveal is the first character of
 * the local part and the full domain, and those two together are enough to catch
 * the case that matters: the profile remembering someone else entirely.
 *
 * Anything unreadable returns false. A false here costs one extra click on
 * "Sign in using another account"; a wrong true types this account's password
 * into somebody else's sign-in, which is both a failed login attempt and an
 * attempt against an identity that is not ours.
 */
export function rememberedAccountMatches(maskedEmail: string, ourEmail: string): boolean {
  const masked = (maskedEmail || '').trim().toLowerCase();
  const ours = (ourEmail || '').trim().toLowerCase();
  if (!masked || !ours) return false;

  const maskedAt = masked.lastIndexOf('@');
  const oursAt = ours.lastIndexOf('@');
  if (maskedAt < 1 || oursAt < 1) return false;

  if (masked.slice(maskedAt + 1) !== ours.slice(oursAt + 1)) return false;
  return masked[0] === ours[0];
}
