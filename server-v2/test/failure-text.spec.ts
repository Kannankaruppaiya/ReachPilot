/**
 * The user-facing failure sentence: `last_error` stays a machine code, but a
 * notification must say what LinkedIn refused (e.g. an email-gated invite), not
 * "skipped: email required".
 */
import { failureText } from '@/modules/drivers/linkedin-driver.interface';

describe('failureText', () => {
  it('explains the email-address wall instead of echoing the code', () => {
    const t = failureText('email_required');
    expect(t).toMatch(/email address/i);
    expect(t).toMatch(/not sent|manually/i);
    expect(t).not.toMatch(/_/);
  });

  it('never leaks a raw outcome enum for the codes the worker can surface', () => {
    for (const code of ['no_connect_button', 'profile_gone', 'blocked', 'follow_only_profile']) {
      expect(failureText(code)).not.toContain('_');
    }
  });

  it('degrades to the de-underscored code for unmapped signals', () => {
    expect(failureText('some_new_signal')).toBe('some new signal');
    expect(failureText(undefined)).toBe('unknown error');
  });
});
