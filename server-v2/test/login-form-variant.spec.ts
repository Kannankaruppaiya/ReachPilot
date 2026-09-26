/**
 * LinkedIn's two sign-in pages. A remembered device (our persistent profiles)
 * gets "Welcome back": name, masked email, password only, no email input. If the
 * masked email doesn't match ours (or can't be read), use "Sign in using another
 * account" rather than type our password into someone else's sign-in.
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
    // Unknown layout: don't type credentials into it.
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
