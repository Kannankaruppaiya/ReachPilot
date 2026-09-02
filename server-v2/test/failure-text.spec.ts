/**
 * The user-facing failure sentence.
 *
 * `last_error` stays a machine code (dashboard/scheduler match on it), but the
 * notification must read as a sentence. The regression this guards: a live
 * connect job against a member whose privacy setting demands an email address
 * returned `no_connect_button`/`email_required` (verified in agent.log), and the
 * user was told "skipped: email required" — which reads as if OUR app wanted an
 * email, not as LinkedIn refusing the invite.
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
