/**
 * Which LinkedIn sign-in page is this? A recognised device (our persistent
 * profiles) gets "Welcome back": name, masked email, password only, no email
 * input. Pure, so the policy is testable without a browser.
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
 * Does the remembered (masked) email plausibly match ours? Compares the first
 * character and the domain. Unreadable → false: an extra click is cheap, typing
 * our password into someone else's sign-in is not.
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
