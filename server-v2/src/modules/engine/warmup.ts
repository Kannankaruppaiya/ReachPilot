/**
 * Warm-up ramp — the SINGLE source of truth for how a LinkedIn account's daily
 * allowance grows over time. Used by PacingService (to enforce the cap) and by
 * the accounts API (to show the user their real warm-up state). Keeping both on
 * this one function means the number the UI shows always matches what the engine
 * actually allows.
 *
 * Curve (Expandi default): start at 5/day, add 3 every 2 days, up to the target,
 * capped by the account's configured warmup_daily_limit.
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

export function computeWarmup(
  connectedAt: Date | string | null | undefined,
  warmupDailyLimit?: number | null,
  warmupTarget?: number | null,
  now: Date = new Date(),
): WarmupState {
  const target = Number(warmupTarget) || Number(warmupDailyLimit) || 21;
  const cap = Number(warmupDailyLimit) || target;

  const ageDays = connectedAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(connectedAt).getTime()) / 86400000))
    : 0;

  const ramped = Math.min(target, START + STEP * Math.floor(ageDays / EVERY_DAYS));
  const todayLimit = Math.max(1, Math.min(ramped, cap));

  // Days for the ramp to climb from START to target, minus the age so far.
  const totalRampDays = Math.ceil(Math.max(0, target - START) / STEP) * EVERY_DAYS;
  const daysToFull = todayLimit >= target ? 0 : Math.max(0, totalRampDays - ageDays);

  const progressPct = target > 0 ? Math.min(100, Math.round((todayLimit / target) * 100)) : 100;

  return { todayLimit, target, progressPct, daysToFull };
}
