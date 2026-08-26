/**
 * LinkedIn serves two different sign-in pages, and we only ever handled one.
 *
 * The driver runs each account in a PERSISTENT browser profile on purpose — a
 * remembered device gets challenged far less. But a remembered device also gets
 * a different login page: instead of the usual email+password form, LinkedIn
 * shows "Welcome back", the account's name and a MASKED email, and a password
 * field only. There is no username input at all.
 *
 * The driver's first act was to type the email into
 * `input[autocomplete="username"]`, which on that page does not exist —
 * `typeLikeHuman` waits 15s, throws, and `finally` closes the browser. So every
 * re-login through an established profile failed, which is exactly the situation
 * where a re-login is needed. Observed live on 2026-08-26.
 *
 * The masked email matters for safety: if the profile remembers a DIFFERENT
 * account, typing this account's password into it is both wrong and a failed
 * login attempt against someone else's identity. When it doesn't match (or
 * cannot be read), take the "Sign in using another account" route instead.
 */
import {
  classifyLoginForm,
  rememberedAccountMatches,
} from '@/modules/drivers/linkedin-login-form';

describe('which sign-in page are we on', () => {
  it('recognises the usual email + password form', () => {
    expect(classifyLoginForm({ hasUsernameField: true, hasPasswordField: true })).toBe('full');
  });

  it('THE BUG: recognises the remembered-device page, which has no email field', () => {
    expect(classifyLoginForm({ hasUsernameField: false, hasPasswordField: true })).toBe(
      'remembered',
    );
  });

  it('reports an unknown page rather than guessing', () => {
    // A checkpoint, an interstitial, or a layout we have never seen. Guessing
    // here means typing credentials into an unknown form.
    expect(classifyLoginForm({ hasUsernameField: false, hasPasswordField: false })).toBe(
      'unknown',
    );
  });
});

describe('is the remembered account OURS', () => {
  it('accepts the masked form of the same address', () => {
    expect(rememberedAccountMatches('g*****@gmail.com', 'greatworksramesh@gmail.com')).toBe(true);
  });

  it('rejects a different mailbox on the same domain', () => {
    expect(rememberedAccountMatches('k*****@gmail.com', 'greatworksramesh@gmail.com')).toBe(false);
  });

  it('rejects the same first letter on a different domain', () => {
    expect(rememberedAccountMatches('g*****@outlook.com', 'greatworksramesh@gmail.com')).toBe(
      false,
    );
  });

  it('ignores case and surrounding whitespace', () => {
    expect(rememberedAccountMatches('  G*****@GMAIL.COM ', 'greatworksramesh@gmail.com')).toBe(
      true,
    );
  });

  it('refuses to match when the masked address could not be read', () => {
    // Unreadable must mean "use another account", never "assume it's us".
    expect(rememberedAccountMatches('', 'greatworksramesh@gmail.com')).toBe(false);
    expect(rememberedAccountMatches('Jayasudha Ramesh T', 'greatworksramesh@gmail.com')).toBe(
      false,
    );
  });

  it('refuses to match when we do not know our own address', () => {
    expect(rememberedAccountMatches('g*****@gmail.com', '')).toBe(false);
  });
});
