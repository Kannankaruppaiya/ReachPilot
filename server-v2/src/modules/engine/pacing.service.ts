import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Kysely } from 'kysely';
import { getEnv } from '@/config/env';
import { getDb } from '@/db';
import type { DatabaseSchema } from '@/db';
import { withWorkspace } from '@/db/rls';
import { computeWarmup, warmupOrigin } from './warmup';

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
   * Can this job send now? Checks spacing, daily and weekly caps, the campaign
   * cap, working hours and weekends in the account timezone. Blocked → returns
   * when to retry; allowed → registers the slot.
   */
  async checkPacingAndRegister(
    accountId: string,
    kind: 'linkedin' | 'email',
    workspaceId?: string,
    isInvite = true,
    campaignId?: string | null,
  ): Promise<{ allowed: boolean; nextScheduledAt?: string }> {
    // No account: nothing to pace (and '' would be an invalid uuid).
    if (!accountId) return { allowed: true };

    const redis = getRedis();
    const read = <T>(fn: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> =>
      workspaceId ? withWorkspace(workspaceId, fn) : fn(getDb());

    const now = new Date();

    // Campaign jobs are also capped by the campaign's daily_cap (UTC day, so a
    // mixed LinkedIn + email campaign shares one count).
    let campaignCap = 0;
    const campDateIso = now.toLocaleDateString('en-US');
    if (campaignId) {
      const camp = await read((db) =>
        db.selectFrom('campaigns').select('daily_cap').where('id', '=', campaignId).executeTakeFirst(),
      ).catch(() => undefined);
      campaignCap = Number(camp?.daily_cap || 0);
    }
    // Take the campaign slot after the account gates pass; roll back if blocked.
    const takeCampaignSlot = async (accountDailyKey: string, deferAt: string) => {
      if (!campaignId || campaignCap <= 0) return null;
      const campKey = `pacing:campaign:${campaignId}:date:${campDateIso}:daily`;
      const n = await redis.incr(campKey);
      await redis.expire(campKey, 86400 * 2);
      if (n > campaignCap) {
        await redis.decr(campKey); // over the campaign cap
        await redis.decr(accountDailyKey); // give the account slot back
        return { allowed: false as const, nextScheduledAt: deferAt };
      }
      return null;
    };

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

      const tz = account.timezone || 'UTC';
      const localTimeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour12: false });
      const localDay = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
      const localDateIso = now.toLocaleDateString('en-US', { timeZone: tz });

      const hoursStart = account.hours_start || '09:00';
      const hoursEnd = account.hours_end || '18:00';

      // Weekend: retry at the next day's open (the scheduler re-defers if needed).
      const isWeekend = localDay === 'Sat' || localDay === 'Sun';
      if (isWeekend && !account.send_weekends) {
        return { allowed: false, nextScheduledAt: this.localWallClockToUtc(tz, hoursStart, 1) };
      }

      // Working hours in the account's local time; end < start wraps past midnight.
      const wrapsMidnight = hoursEnd < hoursStart;
      const inWindow = wrapsMidnight
        ? localTimeStr >= hoursStart || localTimeStr <= hoursEnd
        : localTimeStr >= hoursStart && localTimeStr <= hoursEnd;
      if (!inWindow) {
        // Retry at the open: later today if before it, otherwise tomorrow.
        const dayOffset = localTimeStr < hoursStart ? 0 : 1;
        return { allowed: false, nextScheduledAt: this.localWallClockToUtc(tz, hoursStart, dayOffset) };
      }

      // Minimum gap between actions, re-rolled for every action (see
      // interactionGapMs). Stored as the absolute next-allowed instant so a re-checked
      // job gets the same answer. Checked before the daily counter so a spacing defer
      // doesn't use a slot.
      const nextAllowedKey = `pacing:linkedin:${accountId}:nextallowed`;
      const nextAllowedMs = Number((await redis.get(nextAllowedKey)) || 0);
      if (nextAllowedMs && now.getTime() < nextAllowedMs) {
        return { allowed: false, nextScheduledAt: new Date(nextAllowedMs).toISOString() };
      }

      // Warm-up ramp (computeWarmup, shared with the UI) plus ±15% daily jitter.
      // Ramp from the earlier of connected_at/created_at: connected_at resets on
      // every credential update.
      const connectedAt = warmupOrigin(account.connected_at, account.created_at);
      const baseLimit = computeWarmup(
        connectedAt,
        account.warmup_daily_limit,
        account.warmup_target,
        now,
      ).todayLimit;
      const effectiveDailyLimit = this.jitterDailyLimit(baseLimit, accountId, localDateIso);

      const dailyKey = `pacing:linkedin:${accountId}:date:${localDateIso}:daily`;
      const dailyCount = await redis.incr(dailyKey);
      await redis.expire(dailyKey, 86400 * 2); // 2 days expiry

      if (dailyCount > effectiveDailyLimit) {
        await redis.decr(dailyKey);
        return { allowed: false, nextScheduledAt: this.localWallClockToUtc(tz, hoursStart, 1) };
      }

      // Passed: roll this action's cool-down. dailyCount is the sequence number, so
      // each action gets a different gap.
      await redis.set(
        nextAllowedKey,
        String(now.getTime() + this.interactionGapMs(accountId, localDateIso, dailyCount)),
        'EX',
        86400 * 2,
      );

      const campBlocked = await takeCampaignSlot(
        dailyKey,
        this.localWallClockToUtc(tz, hoursStart, 1),
      );
      if (campBlocked) return campBlocked;

      // The weekly cap applies to invites only.
      if (!isInvite) return { allowed: true };

      const weeklyKey = `pacing:linkedin:${accountId}:weekly`;
      const weeklyCount = await redis.incr(weeklyKey);
      if (weeklyCount === 1) {
        await redis.expire(weeklyKey, 86400 * 7);
      }

      if (weeklyCount > account.weekly_invite_cap) {
        await redis.decr(weeklyKey);
        // Retry at the next day's open until the weekly window frees a slot.
        return { allowed: false, nextScheduledAt: this.localWallClockToUtc(tz, hoursStart, 1) };
      }

    } else {
      const account = await read((db) =>
        db
          .selectFrom('email_accounts')
          .select(['daily_limit', 'connected_at', 'created_at'])
          .where('id', '=', accountId)
          .executeTakeFirst(),
      );

      if (!account) return { allowed: true };

      // Warm-up: start at 5/day, add 5/day up to daily_limit.
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

      // Per-campaign daily cap (rolls back the account slot if over).
      const tomorrow9 = new Date(now.getTime() + 86400000);
      tomorrow9.setHours(9, 0, 0, 0);
      const campBlocked = await takeCampaignSlot(dailyKey, tomorrow9.toISOString());
      if (campBlocked) return campBlocked;
    }

    return { allowed: true };
  }

  /** Random jitter between 30 and 180 seconds. */
  getRandomJitterMs(): number {
    const min = 30;
    const max = 180;
    const s = Math.floor(Math.random() * (max - min + 1)) + min;
    return s * 1000;
  }

  /**
   * Give back a registered slot that wasn't spent (send failed or account
   * unusable), so a retry doesn't count twice. Best-effort and idempotent.
   */
  async release(
    accountId: string,
    kind: 'linkedin' | 'email',
    workspaceId?: string,
    isInvite = true,
    campaignId?: string | null,
  ): Promise<void> {
    if (!accountId) return;
    const redis = getRedis();
    const now = new Date();

    // Give back the per-campaign daily slot too, if this was a campaign send.
    if (campaignId) {
      const campDateIso = now.toLocaleDateString('en-US');
      await redis
        .decr(`pacing:campaign:${campaignId}:date:${campDateIso}:daily`)
        .catch(() => undefined);
    }

    if (kind === 'linkedin') {
      const read = <T>(fn: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> =>
        workspaceId ? withWorkspace(workspaceId, fn) : fn(getDb());
      const account = await read((db) =>
        db.selectFrom('linkedin_accounts').select(['timezone']).where('id', '=', accountId).executeTakeFirst(),
      ).catch(() => undefined);
      const tz = account?.timezone || 'UTC';
      const localDateIso = now.toLocaleDateString('en-US', { timeZone: tz });
      await redis.decr(`pacing:linkedin:${accountId}:date:${localDateIso}:daily`).catch(() => undefined);
      // The action never happened, so don't charge its cool-down either.
      await redis.del(`pacing:linkedin:${accountId}:nextallowed`).catch(() => undefined);
      if (isInvite) await redis.decr(`pacing:linkedin:${accountId}:weekly`).catch(() => undefined);
    } else {
      const localDateIso = now.toLocaleDateString('en-US');
      await redis.decr(`pacing:email:${accountId}:date:${localDateIso}:daily`).catch(() => undefined);
    }
  }

  /** Stable hash → [0,1): same inputs, same value. */
  private seed01(...parts: string[]): number {
    let h = 2166136261;
    for (const p of parts.join('|')) h = (h ^ p.charCodeAt(0)) * 16777619;
    return ((h >>> 0) % 100000) / 100000;
  }

  /** ±15% daily cap jitter, deterministic per account and day. */
  public jitterDailyLimit(base: number, accountId: string, dateIso: string): number {
    const factor = 0.85 + this.seed01(accountId, dateIso, 'daily') * 0.3; // 0.85–1.15
    return Math.max(1, Math.round(base * factor));
  }

  /**
   * Cool-down before this account's next action, re-rolled per action: a constant
   * gap is a fingerprint. `seq` keeps each roll deterministic, so re-checking a
   * blocked job never moves its target time.
   */
  private interactionGapMs(accountId: string, dateIso: string, seq: number): number {
    const s = String(seq);
    // ~15% of actions: a long pause, the way a human steps away mid-session.
    if (this.seed01(accountId, dateIso, 'gaproll', s) < 0.15) {
      const mins = 8 + this.seed01(accountId, dateIso, 'gapmag', s) * 12; // 8–20 min
      return Math.round(mins * 60_000);
    }
    // Otherwise 90s–7 min, skewed short — most actions follow fairly quickly.
    const mins = 1.5 + Math.pow(this.seed01(accountId, dateIso, 'gapmag', s), 1.6) * 5.5;
    return Math.round(mins * 60_000);
  }

  /**
   * UTC ISO for wall-clock `hhmm` in `tz`, `dayOffset` days ahead. Up to an hour
   * off across DST; the scheduler re-checks when the job comes due.
   */
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
