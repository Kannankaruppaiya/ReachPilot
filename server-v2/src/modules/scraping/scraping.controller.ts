import { Controller, Post, Body, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';
import { JwtPayload } from '@/common/auth.guard';

// Lazy singleton producer (same pattern as jobs.service) — the browser scrape
// runs in the worker, so the API only enqueues and returns immediately.
let redisClient: Redis | null = null;
let scrapeQueue: Queue | null = null;
function getScrapeQueue(): Queue {
  if (scrapeQueue) return scrapeQueue;
  const env = getEnv();
  if (!redisClient) redisClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  scrapeQueue = new Queue('lead-scrape', { connection: redisClient as any });
  return scrapeQueue;
}

@Controller('api/leads')
export class ScrapingController {
  /**
   * Kick off a free local Google → LinkedIn lead scrape. Enqueues a worker job
   * (headful stealth browser lives in the worker) and returns at once; scraped
   * profiles land in the leads table via the normal import path (with dedup).
   */
  @Post('scrape')
  async scrape(
    @Body() body: { titles?: string[]; location?: string; maxResults?: number },
    @Req() req: Request,
  ) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;

    const titles = (body.titles || [])
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .slice(0, 6);
    if (!titles.length) {
      throw new BadRequestException('At least one job title is required.');
    }
    const location = body.location ? String(body.location).trim() : undefined;
    const maxResults = Math.min(Math.max(Number(body.maxResults) || 15, 1), 50);

    await getScrapeQueue().add('scrape', { workspaceId, titles, location, maxResults });
    return { ok: true, queued: true, titles, location, maxResults };
  }
}
