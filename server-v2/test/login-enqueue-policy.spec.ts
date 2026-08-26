/**
 * When may we (re-)log an account into LinkedIn?
 *
 * Learned live on 2026-08-26. An account was signed out server-side, so its
 * stored cookie was dead. The user pressed "Update LinkedIn login" three times
 * (16:00, 16:48, 17:04); each press stored a fresh password + TOTP seed and the
 * UI cheerfully said "reconnecting your account…" — but `enqueueLogin` bailed out
 * every time on "this account already has a session", so no login was ever
 * enqueued and `last_sync_at` stayed on 2026-07-21. A dead cookie made itself
 * unreplaceable: the only state that could fix the account was the one thing the
 * guard refused to let us change.
 *
 * The guard itself is right — repeated automated logins are the top ban trigger.
 * What it lacked was the distinction between "something asked for a login" and
 * "the human just re-entered their credentials on purpose".
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
    // Without this the account is stuck forever: the stale cookie blocks the
    // login that would replace it, and nothing else can clear it.
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
    // Forcing bypasses the SESSION guard, never the rate limit. The user pressed
    // the button three times in an hour; that must stay one login attempt.
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
    // 6h is right for automatic retries. For a human who just fixed their
    // password it is a lockout: one failed attempt and they cannot try again
    // today. Long enough to swallow a double-click, short enough to retry.
    const forced = decideLogin({ hasSession: false, forced: true, cooldownActive: false });
    const auto = decideLogin({ hasSession: false, forced: false, cooldownActive: false });

    expect(forced.cooldownSeconds).toBeLessThanOrEqual(300);
    expect(forced.cooldownSeconds).toBeGreaterThanOrEqual(60);
    expect(auto.cooldownSeconds).toBe(6 * 3600);
  });
});
