import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { getEnv } from '@/config/env';

/**
 * Per-workspace scrape cursor in Redis: how many result pages a search has
 * consumed, so a rerun continues at the next unseen page instead of page 1.
 */
@Injectable()
export class ScrapeCursorService {
  private readonly logger = new Logger(ScrapeCursorService.name);
  private redis?: Redis;
  private static readonly TTL_SECONDS = 60 * 60 * 24 * 30; // reset an idle search after 30d

  private client(): Redis {
    if (!this.redis) this.redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    return this.redis;
  }

  /** Stable key for a (titles, location) search — order/case-insensitive. */
  queryKey(titles: string[], location?: string): string {
    const norm =
      titles.map((t) => t.trim().toLowerCase()).filter(Boolean).sort().join('|') +
      '::' +
      (location || '').trim().toLowerCase();
    return createHash('sha1').update(norm).digest('hex').slice(0, 16);
  }

  private redisKey(ws: string, qk: string): string {
    return `scrape:cursor:${ws}:${qk}`;
  }

  /** The next page index to start this run from (0 if never scraped). */
  async nextPage(ws: string, qk: string): Promise<number> {
    try {
      const v = await this.client().get(this.redisKey(ws, qk));
      return v ? parseInt(v, 10) || 0 : 0;
    } catch (err: any) {
      this.logger.warn(`cursor read failed (starting at 0): ${err?.message || err}`);
      return 0;
    }
  }

  /** Advance the cursor by `pages` so the next run continues past them. */
  async advance(ws: string, qk: string, pages: number): Promise<void> {
    if (pages <= 0) return;
    try {
      const key = this.redisKey(ws, qk);
      await this.client().incrby(key, pages);
      await this.client().expire(key, ScrapeCursorService.TTL_SECONDS);
    } catch (err: any) {
      this.logger.warn(`cursor advance failed (non-fatal): ${err?.message || err}`);
    }
  }

  /** Reset a search's cursor — a deliberate "start fresh" re-sweep. */
  async reset(ws: string, qk: string): Promise<void> {
    try {
      await this.client().del(this.redisKey(ws, qk));
    } catch {
      /* non-fatal */
    }
  }
}
