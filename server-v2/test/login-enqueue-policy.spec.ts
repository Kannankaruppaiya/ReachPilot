/**
 * When may an account be logged in again? A stored session blocks automatic
 * logins (the top ban trigger), but a user re-entering credentials must get
 * one, or a dead cookie makes the account unrecoverable.
 */
import { decideLogin } from '@/modules/accounts/login-policy';

describe('login enqueue policy', () => {
  it('logs in a freshly connected account', () => {
    const d = decideLogin({ hasSession: false, forced: false, cooldownActive: false });

    expect(d.enqueue).toBe(true);
    expect(d.clearStoredSession).toBe(false);
  });

  it('leaves a healthy account alone when nothing asked for a re-login', () => {
    // The cookie IS the session; re-logging in unprompted is the ban trigger.
    const d = decideLogin({ hasSession: true, forced: false, cooldownActive: false });

    expect(d.enqueue).toBe(false);
    expect(d.reason).toBe('has_session');
  });

  it('THE BUG: a deliberate credential update re-logs in even with a session stored', () => {
    const d = decideLogin({ hasSession: true, forced: true, cooldownActive: false });

    expect(d.enqueue).toBe(true);
  });

  it('THE BUG: and drops the stored session, so the dead cookie cannot block again', () => {
    // Otherwise the stale cookie blocks the login that would replace it, forever.
    const d = decideLogin({ hasSession: true, forced: true, cooldownActive: false });

    expect(d.clearStoredSession).toBe(true);
  });

  it('has nothing to clear when a forced login finds no stored session', () => {
    const d = decideLogin({ hasSession: false, forced: true, cooldownActive: false });

    expect(d.enqueue).toBe(true);
    expect(d.clearStoredSession).toBe(false);
  });

  it('still respects the cooldown on an unforced login', () => {
    const d = decideLogin({ hasSession: false, forced: false, cooldownActive: true });

    expect(d.enqueue).toBe(false);
    expect(d.reason).toBe('cooldown');
  });

  it('respects the cooldown even when forced — a double-click is not two logins', () => {
    // Forcing bypasses the session guard, never the rate limit: three presses, one login.
    const d = decideLogin({ hasSession: true, forced: true, cooldownActive: true });

    expect(d.enqueue).toBe(false);
    expect(d.reason).toBe('cooldown');
  });

  it('never clears the stored session when it is not going to log in', () => {
    // Clearing without replacing would sign the account out for nothing.
    const blocked = decideLogin({ hasSession: true, forced: true, cooldownActive: true });

    expect(blocked.clearStoredSession).toBe(false);
  });

  it('cools a forced login down for minutes, not the unforced six hours', () => {
    // 6h suits automatic retries; after a manual fix it would be a lockout.
    const forced = decideLogin({ hasSession: false, forced: true, cooldownActive: false });
    const auto = decideLogin({ hasSession: false, forced: false, cooldownActive: false });

    expect(forced.cooldownSeconds).toBeLessThanOrEqual(300);
    expect(forced.cooldownSeconds).toBeGreaterThanOrEqual(60);
    expect(auto.cooldownSeconds).toBe(6 * 3600);
  });
});
