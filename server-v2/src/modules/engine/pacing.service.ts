import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Kysely } from 'kysely';
import { getEnv } from '@/config/env';
import { getDb } from '@/db';
import type { DatabaseSchema } from '@/db';
import { withWorkspace } from '@/db/rls';
import { computeWarmup } from './warmup';

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const env = getEnv();
  redisClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return redisClient;
}

@Injectable()
export class PacingService {
  /**
   * Evaluates if a job can be sent right now based on pacing rules:
   * 1. Daily limit counters in Redis (warmup_daily_limit, email daily_limit).
   * 2. Weekly invite cap (~100 / week for LinkedIn).
   * 3. Working hours (e.g., 09:00 - 18:00) in account timezone.
   * 4. Weekend flag (send_weekends).
   *
   * If blocked, returns the timestamp when it should be retried.
   * If allowed, increments daily counters and returns null.
   */
  async checkPacingAndRegister(
    accountId: string,
    kind: 'linkedin' | 'email',
    workspaceId?: string,
    isInvite = true,
  ): Promise<{ allowed: boolean; nextScheduledAt?: string }> {
    // No account linked → nothing to pace against (defensive; an empty string
    // would otherwise be sent to Postgres as an invalid uuid).
    if (!accountId) return { allowed: true };

    const redis = getRedis();
    // Account reads are RLS-scoped when a workspace is known (worker context).
    const read = <T>(fn: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> =>
      workspaceId ? withWorkspace(workspaceId, fn) : fn(getDb());

    const now = new Date();

    if (kind === 'linkedin') {
      const account = await read((db) =>
        db
          .selectFrom('linkedin_accounts')
          .select([
            'warmup_daily_limit',
            'warmup_target',
            'weekly_invite_cap',
            'hours_start',
            'hours_end',
            'send_weekends',
            'timezone',
            'connected_at',
            'created_at',
          ])
          .where('id', '=', accountId)
          .executeTakeFirst(),
      );

      if (!account) return { allowed: true };

      // Timezone-based evaluation
      const tz = account.timezone || 'UTC';
      const localTimeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour12: false });
      const localDay = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
      const localDateIso = now.toLocaleDateString('en-US', { timeZone: tz });

      const hoursStart = account.hours_start || '09:00';
      const hoursEnd = account.hours_end || '18:00';

      // Weekend check → resume at next day's opening (scheduler re-checks and
      // re-defers if it's still the weekend, so a single day hop is enough).
      const isWeekend = localDay === 'Sat' || localDay === 'Sun';
      if (isWeekend && !account.send_weekends) {
        return { allowed: false, nextScheduledAt: this.localWallClockToUtc(tz, hoursStart, 1) };
      }

      // Business hours check (all comparisons in the account's local wall clock).
      // An end earlier than the start means the window wraps past midnight
      // (e.g. 06:00 → 03:00 keeps sending into the small hours of the next day).
      const wrapsMidnight = hoursEnd < hoursStart;
      const inWindow = wrapsMidnight
        ? localTimeStr >= hoursStart || localTimeStr <= hoursEnd
        : localTimeStr >= hoursStart && localTimeStr <= hoursEnd;
      if (!inWindow) {
        // Resume at the opening hour: later today if we're before the start
        // (including the wrapped gap, e.g. 03:00–06:00), otherwise tomorrow.
        const dayOffset = localTimeStr < hoursStart ? 0 : 1;
        return { allowed: false, nextScheduledAt: this.localWallClockToUtc(tz, hoursStart, dayOffset) };
      }

      // ---- Inter-action spacing (spread the day's quota, don't burst) ----
      // Expandi-style: a fresh cold account firing its whole daily quota in a
      // 3-minute window is a bot signal. Enforce a minimum gap between actions on
      // this account; the exact gap is randomized per account/day so it isn't a
      // mechanical constant. Checked BEFORE the daily counter so a spacing defer
      // doesn't consume a slot.
      const lastKey = `pacing:linkedin:${accountId}:lastaction`;
      const lastActionMs = Number((await redis.get(lastKey)) || 0);
      const minGapMs = this.interactionGapMs(accountId, localDateIso);
      if (lastActionMs && now.getTime() - lastActionMs < minGapMs) {
        const readyAt = new Date(lastActionMs + minGapMs).toISOString();
        return { allowed: false, nextScheduledAt: readyAt };
      }

      // ---- Warm-up ramp + daily randomization ----
      // The ramp curve lives in computeWarmup() (shared with the accounts API so
      // the UI shows the same number we enforce). Then jitter the cap ±15%
      // deterministically per day so it isn't a robotic constant.
      const connectedAt = account.connected_at || account.created_at;
      const baseLimit = computeWarmup(
        connectedAt,
        account.warmup_daily_limit,
        account.warmup_target,
        now,
      ).todayLimit;
      const effectiveDailyLimit = this.jitterDailyLimit(baseLimit, accountId, localDateIso);

      // Daily limit counter
      const dailyKey = `pacing:linkedin:${accountId}:date:${localDateIso}:daily`;
      const dailyCount = await redis.incr(dailyKey);
      await redis.expire(dailyKey, 86400 * 2); // 2 days expiry

      if (dailyCount > effectiveDailyLimit) {
        // Rollback incr
        await redis.decr(dailyKey);
        return { allowed: false, nextScheduledAt: this.localWallClockToUtc(tz, hoursStart, 1) };
      }

      // Passed the daily gate → stamp the action time for spacing (2-day TTL).
      await redis.set(lastKey, String(now.getTime()), 'EX', 86400 * 2);

      // Weekly cap applies to INVITES only — profile views, follows, likes and
      // endorsements are paced by the daily counter above but don't burn the
      // weekly connection-request allowance.
      if (!isInvite) return { allowed: true };

      const weeklyKey = `pacing:linkedin:${accountId}:weekly`;
      const weeklyCount = await redis.incr(weeklyKey);
      if (weeklyCount === 1) {
        await redis.expire(weeklyKey, 86400 * 7);
      }

      if (weeklyCount > account.weekly_invite_cap) {
        await redis.decr(weeklyKey);
        // Weekly cap: resume at the next day's opening hour; the scheduler keeps
        // re-deferring until the rolling weekly window frees up a slot.
        return { allowed: false, nextScheduledAt: this.localWallClockToUtc(tz, hoursStart, 1) };
      }

    } else {
      // Email pacing
      const account = await read((db) =>
        db
          .selectFrom('email_accounts')
          .select(['daily_limit', 'connected_at', 'created_at'])
          .where('id', '=', accountId)
          .executeTakeFirst(),
      );

      if (!account) return { allowed: true };

      // Warm-up ramp: a fresh mailbox sending its full quota on day one is a
      // spam signal. Start at 5/day and add 5/day until it reaches daily_limit.
      const connectedAt = account.connected_at || account.created_at;
      const ageDays = connectedAt
        ? Math.floor((now.getTime() - new Date(connectedAt).getTime()) / 86400000)
        : 0;
      const warmupLimit = 5 + 5 * Math.max(0, ageDays);
      const effectiveLimit = Math.min(account.daily_limit, warmupLimit);

      const localDateIso = now.toLocaleDateString('en-US');

      const dailyKey = `pacing:email:${accountId}:date:${localDateIso}:daily`;
      const dailyCount = await redis.incr(dailyKey);
      await redis.expire(dailyKey, 86400 * 2);

      if (dailyCount > effectiveLimit) {
        await redis.decr(dailyKey);
        const tomorrow = new Date(now.getTime() + 86400000);
        tomorrow.setHours(9, 0, 0, 0);
        return { allowed: false, nextScheduledAt: tomorrow.toISOString() };
      }
    }

    return { allowed: true };
  }

  /**
   * Generates a random jitter between 30 and 180 seconds.
   */
  getRandomJitterMs(): number {
    const min = 30;
    const max = 180;
    const s = Math.floor(Math.random() * (max - min + 1)) + min;
    return s * 1000;
  }

  /**
   * Releases a pacing slot that was registered but not spent — e.g. the send
   * failed, or the account turned out to be unusable after the counter was
   * incremented. Without this, a failed-then-retried job would consume the
   * daily quota twice. Best-effort; safe to call more than once (decr floors
   * are re-corrected on the next tick).
   */
  async release(accountId: string, kind: 'linkedin' | 'email', workspaceId?: string, isInvite = true): Promise<void> {
    if (!accountId) return;
    const redis = getRedis();
    const now = new Date();

    if (kind === 'linkedin') {
      const read = <T>(fn: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> =>
        workspaceId ? withWorkspace(workspaceId, fn) : fn(getDb());
      const account = await read((db) =>
        db.selectFrom('linkedin_accounts').select(['timezone']).where('id', '=', accountId).executeTakeFirst(),
      ).catch(() => undefined);
      const tz = account?.timezone || 'UTC';
      const localDateIso = now.toLocaleDateString('en-US', { timeZone: tz });
      await redis.decr(`pacing:linkedin:${accountId}:date:${localDateIso}:daily`).catch(() => undefined);
      // Only give back a weekly-invite slot if we consumed one.
      if (isInvite) await redis.decr(`pacing:linkedin:${accountId}:weekly`).catch(() => undefined);
    } else {
      const localDateIso = now.toLocaleDateString('en-US');
      await redis.decr(`pacing:email:${accountId}:date:${localDateIso}:daily`).catch(() => undefined);
    }
  }

  /**
   * UTC ISO for wall-clock `hhmm` in timezone `tz`, `dayOffset` days from today.
   *
   * Timezone-correct without a date library: a wall-clock instant T in `tz`
   * equals `T − offset` in UTC, where `offset` is how far ahead of UTC the zone
   * is right now. Approximate across a DST boundary (at most an hour off), which
   * is fine — the scheduler re-checks pacing when the job comes due and simply
   * re-defers if the window still isn't open, so any estimate self-corrects.
   */
  /** Small stable hash → [0,1). Same account+day always yields the same value. */
  private seed01(...parts: string[]): number {
    let h = 2166136261;
    for (const p of parts.join('|')) h = (h ^ p.charCodeAt(0)) * 16777619;
    return ((h >>> 0) % 100000) / 100000;
  }

  /**
   * Jitter the daily cap ±15% deterministically per account/day, so the number
   * of actions varies day-to-day (12, then 14, then 11…) instead of a robotic
   * constant. Deterministic so repeated pacing checks the same day agree.
   */
  private jitterDailyLimit(base: number, accountId: string, dateIso: string): number {
    const factor = 0.85 + this.seed01(accountId, dateIso, 'daily') * 0.3; // 0.85–1.15
    return Math.max(1, Math.round(base * factor));
  }

  /**
   * Minimum gap between consecutive actions on an account, randomized per
   * account/day within 6–14 minutes. Spreads the daily quota across working
   * hours rather than letting it burst.
   */
  private interactionGapMs(accountId: string, dateIso: string): number {
    const minMin = 6;
    const spanMin = 8; // → 6–14 min
    const mins = minMin + this.seed01(accountId, dateIso, 'gap') * spanMin;
    return Math.round(mins * 60_000);
  }

  private localWallClockToUtc(tz: string, hhmm: string, dayOffset: number): string {
    const [hh, mm] = hhmm.split(':').map((n) => parseInt(n, 10) || 0);
    const now = new Date();
    const utcMs = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
    const tzMs = new Date(now.toLocaleString('en-US', { timeZone: tz })).getTime();
    const offsetMs = tzMs - utcMs; // how far ahead of UTC `tz` is
    // Today's Y-M-D in `tz` (en-CA yields YYYY-MM-DD).
    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const [y, mo, d] = ymd.split('-').map((n) => parseInt(n, 10));
    const asIfUtc = Date.UTC(y, mo - 1, d + dayOffset, hh, mm, 0);
    return new Date(asIfUtc - offsetMs).toISOString();
  }
}
