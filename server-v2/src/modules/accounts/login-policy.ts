/**
 * When an account may be (re-)logged into LinkedIn.
 *
 * Repeated automated logins are the single biggest ban trigger, so the default
 * answer is "no": if a session cookie is stored, that cookie IS the login and we
 * leave it be. But a cookie can die server-side — LinkedIn signs the account out
 * — and then that same guard becomes a trap. The stale cookie blocks the login
 * that would replace it, and nothing else can clear it, so the account can never
 * recover on its own. Observed live: three "Update LinkedIn login" presses, three
 * fresh credential records stored, zero logins enqueued.
 *
 * The missing distinction is intent. A human re-entering their credentials is
 * telling us the old session is no good; an automatic call is not. So `forced`
 * bypasses the SESSION guard — and only that guard. The rate limit still applies,
 * because a user pressing the button three times must still be one login.
 *
 * Pure, so the policy is testable without Redis or Postgres.
 */

/** Repeated automated logins are the #1 ban trigger — cool down between attempts. */
export const LOGIN_COOLDOWN_SECONDS = 6 * 3600;
/**
 * Cool-down after a login the user asked for by hand. Long enough that a
 * double-click is still one attempt; short enough that someone who mistyped a
 * password is not locked out for the rest of the day.
 */
export const FORCED_LOGIN_COOLDOWN_SECONDS = 120;

export interface LoginState {
  /** A session cookie is already stored for this account. */
  hasSession: boolean;
  /** The human just submitted credentials — treat the stored session as suspect. */
  forced: boolean;
  /** A login was already attempted inside the cool-down window. */
  cooldownActive: boolean;
}

export interface LoginDecision {
  enqueue: boolean;
  /** Why we are NOT enqueuing (absent when we are). */
  reason?: 'has_session' | 'cooldown';
  /**
   * Drop the stored session before logging in. Only ever true alongside an
   * actual login: clearing without replacing would sign the account out for
   * nothing.
   */
  clearStoredSession: boolean;
  /** TTL to set on the cool-down key when enqueuing. */
  cooldownSeconds: number;
}

export function decideLogin(state: LoginState): LoginDecision {
  const cooldownSeconds = state.forced
    ? FORCED_LOGIN_COOLDOWN_SECONDS
    : LOGIN_COOLDOWN_SECONDS;

  // Rate limit first: it applies to forced logins too, so a triple-click stays
  // one attempt. Checked before the session guard so a blocked forced login
  // never reports "has_session" — the user would then be told the wrong thing.
  if (state.cooldownActive) {
    return { enqueue: false, reason: 'cooldown', clearStoredSession: false, cooldownSeconds };
  }

  if (state.hasSession && !state.forced) {
    return { enqueue: false, reason: 'has_session', clearStoredSession: false, cooldownSeconds };
  }

  return {
    enqueue: true,
    clearStoredSession: state.hasSession,
    cooldownSeconds,
  };
}
