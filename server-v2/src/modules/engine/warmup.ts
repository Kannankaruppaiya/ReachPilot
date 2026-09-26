// LinkedIn warm-up ramp, shared by PacingService and the accounts API so the UI
// shows what pacing enforces. Starts at 5/day and adds 3 every 2 days up to the
// target (warmup_daily_limit is only a fallback for legacy accounts).

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
 * Ramp origin: the earlier of connected_at and created_at (connect() rewrites
 * connected_at on every credential save). Unparseable dates are ignored, never
 * treated as "infinitely old".
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
  // Fall back to warmup_daily_limit only for legacy accounts with no target.
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
