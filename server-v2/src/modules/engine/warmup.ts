/**
 * Warm-up ramp — the SINGLE source of truth for how a LinkedIn account's daily
 * allowance grows over time. Used by PacingService (to enforce the cap) and by
 * the accounts API (to show the user their real warm-up state). Keeping both on
 * this one function means the number the UI shows always matches what the engine
 * actually allows.
 *
 * Curve (Expandi default): start at 5/day, add 3 every 2 days, up to the
 * warm-up target — the SINGLE daily ceiling. (warmup_daily_limit is kept in
 * sync with the target and only survives as a fallback for legacy accounts
 * that were created before a target was stored.)
 */

export interface WarmupState {
  /** Base actions allowed today (before the ±15% daily jitter). */
  todayLimit: number;
  /** The ceiling the ramp climbs toward. */
  target: number;
  /** todayLimit / target as a 0–100 percentage (for a progress bar). */
  progressPct: number;
  /** Days remaining until the ramp reaches the target. 0 = at full capacity. */
  daysToFull: number;
}

const START = 5;
const STEP = 3;
const EVERY_DAYS = 2;

/** A date we can actually measure from, or null. */
function asTime(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Which date the warm-up ramp should measure from: the EARLIER of when the
 * account was connected and when its row was created.
 *
 * `connect()` rewrites `connected_at` every time credentials are saved — even
 * for an account that already exists — so on its own it answers "when was the
 * password last re-entered", not "how long has this account been running". A
 * long-lived account was knocked back to 5/day by a password change while
 * holding 159 sent invites. `created_at` never moves, so taking the earlier of
 * the two makes the ramp immune to that AND repairs rows already damaged, with
 * no migration.
 *
 * An unparseable date is ignored rather than trusted: `new Date('nonsense')` is
 * NaN, and letting that through would make an account look infinitely old and
 * skip warm-up altogether — failure in the dangerous direction.
 */
export function warmupOrigin<T extends Date | string | null | undefined>(
  connectedAt: T,
  createdAt: T,
): T | null {
  const a = asTime(connectedAt);
  const b = asTime(createdAt);
  if (a === null) return b === null ? null : createdAt;
  if (b === null) return connectedAt;
  return a <= b ? connectedAt : createdAt;
}

export function computeWarmup(
  connectedAt: Date | string | null | undefined,
  warmupDailyLimit?: number | null,
  warmupTarget?: number | null,
  now: Date = new Date(),
): WarmupState {
  // Single ceiling = the warm-up target. Fall back to warmup_daily_limit only
  // for legacy accounts that never had a target set.
  const target = Number(warmupTarget) || Number(warmupDailyLimit) || 21;

  const ageDays = connectedAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(connectedAt).getTime()) / 86400000))
    : 0;

  const ramped = Math.min(target, START + STEP * Math.floor(ageDays / EVERY_DAYS));
  const todayLimit = Math.max(1, ramped);

  // Days for the ramp to climb from START to target, minus the age so far.
  const totalRampDays = Math.ceil(Math.max(0, target - START) / STEP) * EVERY_DAYS;
  const daysToFull = todayLimit >= target ? 0 : Math.max(0, totalRampDays - ageDays);

  const progressPct = target > 0 ? Math.min(100, Math.round((todayLimit / target) * 100)) : 100;

  return { todayLimit, target, progressPct, daysToFull };
}
