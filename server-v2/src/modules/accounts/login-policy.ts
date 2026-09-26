// When an account may be logged in again. Repeated logins are the top ban
// trigger, so a stored session blocks new logins, unless `forced` (the user just
// re-entered credentials, so the old session is suspect). The cooldown still
// applies to forced logins. Pure, so the policy is unit-testable.

/** Repeated automated logins are the #1 ban trigger — cool down between attempts. */
export const LOGIN_COOLDOWN_SECONDS = 6 * 3600;
/** Cooldown after a manual login: a double-click is one attempt, a typo isn't a lockout. */
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
  /** Drop the stored session before logging in (only ever alongside a login). */
  clearStoredSession: boolean;
  /** TTL to set on the cool-down key when enqueuing. */
  cooldownSeconds: number;
}

export function decideLogin(state: LoginState): LoginDecision {
  const cooldownSeconds = state.forced
    ? FORCED_LOGIN_COOLDOWN_SECONDS
    : LOGIN_COOLDOWN_SECONDS;

  // Cooldown first, so a blocked forced login never reports "has_session".
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
