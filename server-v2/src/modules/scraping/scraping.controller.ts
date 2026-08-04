import { Controller, Post, Get, Param, Body, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';
import { JwtPayload } from '@/common/auth.guard';
import { ScrapeJobsService } from './scrape-jobs.service';

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
  constructor(private readonly scrapeJobs: ScrapeJobsService) {}

  /** History of past scrape runs (newest first) — powers the Leads history panel. */
  @Get('scrape-jobs')
  async listJobs(@Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.scrapeJobs.list(workspaceId);
  }

  /** Live status of a single scrape run (the UI polls this while it runs). */
  @Get('scrape-jobs/:id')
  async getJob(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user as JwtPayload;
    const workspaceId = (req as any).workspaceId || user.workspaceId;
    return this.scrapeJobs.get(workspaceId, id);
  }

  /**
   * Kick off a free local Google → LinkedIn lead scrape. Enqueues a worker job
   * (headful stealth browser lives in the worker) and returns at once; scraped
   * profiles land in the leads table via the normal import path (with dedup).
   */
  @Post('scrape')
  async scrape(
    @Body() body: { titles?: string[]; location?: string; maxResults?: number; startFresh?: boolean },
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
    const maxResults = Math.min(Math.max(Number(body.maxResults) || 15, 1), 100);
    // startFresh re-sweeps from page 0 (ignore the rerun cursor) — used when the
    // user wants to re-scan a search space from the top.
    const startFresh = body.startFresh === true;

    // Create the history/progress row first, then hand its id to the worker so it
    // can report status as it runs.
    const scrapeJobId = await this.scrapeJobs.create(workspaceId, { titles, location, maxResults });
    await getScrapeQueue().add('scrape', { workspaceId, titles, location, maxResults, startFresh, scrapeJobId });
    return { ok: true, queued: true, scrapeJobId, titles, location, maxResults, startFresh };
  }
}
