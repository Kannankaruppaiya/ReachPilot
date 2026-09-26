/**
 * The warm-up ramp measures how long the account has run, not when its password
 * was last saved (connect() rewrites connected_at). Anchored to the earlier of
 * connected_at and created_at.
 */
import { warmupOrigin } from '@/modules/engine/warmup';

const JULY = '2026-07-21T14:18:00.000Z';
const TODAY = '2026-08-26T13:09:00.000Z';

describe('warm-up origin', () => {
  it('THE BUG: keeps the original date when a credential update moved connected_at forward', () => {
    expect(warmupOrigin(TODAY, JULY)).toBe(JULY);
  });

  it('uses connected_at when it is the earlier of the two', () => {
    // A row created by an import/seed can predate the actual connection.
    expect(warmupOrigin(JULY, TODAY)).toBe(JULY);
  });

  it('falls back to created_at when the account was never connected', () => {
    expect(warmupOrigin(null, JULY)).toBe(JULY);
  });

  it('falls back to connected_at when created_at is missing', () => {
    expect(warmupOrigin(JULY, null)).toBe(JULY);
  });

  it('returns null when neither date is known, so the caller can decide', () => {
    expect(warmupOrigin(null, null)).toBeNull();
  });

  it('accepts Date objects as well as strings', () => {
    expect(warmupOrigin(new Date(TODAY), new Date(JULY))).toEqual(new Date(JULY));
  });

  it('ignores an unparseable date instead of treating it as the epoch', () => {
    // NaN must not win: an "infinitely old" account would skip warm-up.
    expect(warmupOrigin('nonsense', JULY)).toBe(JULY);
    expect(warmupOrigin(JULY, 'nonsense')).toBe(JULY);
  });
});

describe('the ramp, anchored correctly', () => {
  it('reports full capacity for a long-running account whose password was just changed', async () => {
    const { computeWarmup } = await import('@/modules/engine/warmup');
    const now = new Date(TODAY);

    const damaged = computeWarmup(TODAY, 20, 20, now);
    const repaired = computeWarmup(warmupOrigin(TODAY, JULY), 20, 20, now);

    expect(damaged.todayLimit).toBe(5);
    expect(repaired.todayLimit).toBe(20);
    expect(repaired.daysToFull).toBe(0);
  });

  it('still ramps a genuinely new account from 5', async () => {
    const { computeWarmup } = await import('@/modules/engine/warmup');
    const now = new Date(TODAY);

    const fresh = computeWarmup(warmupOrigin(TODAY, TODAY), 45, 45, now);

    expect(fresh.todayLimit).toBe(5);
  });
});
