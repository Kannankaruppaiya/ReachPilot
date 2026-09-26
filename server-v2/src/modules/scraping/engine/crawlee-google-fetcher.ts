import { Logger } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import { getEnv } from '@/config/env';

/** One raw SERP row — the shared contract between any fetcher and the pipeline. */
export interface SerpRaw {
  title: string;
  href: string;
  snippet: string;
}

export interface CrawleeFetchOptions {
  query: string;
  /** First Google page index to fetch (the cursor). Default 0. */
  startPage?: number;
  /** How many pages to fetch this run. Default 3, capped at 10. */
  pages?: number;
}

/**
 * Google SERP fetcher on Crawlee's PlaywrightCrawler with patchright (queue
 * dedup, pagination, session rotation, retries). Returns the same rows as the
 * legacy fetcher. Storage is in-memory per call. Required lazily so the legacy
 * engine never loads Crawlee.
 */
export class CrawleeGoogleFetcher {
  private readonly logger = new Logger(CrawleeGoogleFetcher.name);

  async fetchRaw(opts: CrawleeFetchOptions): Promise<SerpRaw[]> {
    // Must precede the crawlee require: forces in-memory storage (no ./storage dir).
    process.env.CRAWLEE_PERSIST_STORAGE = '0';
    process.env.CRAWLEE_PURGE_ON_START = '1';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PlaywrightCrawler, RequestQueue } = require('crawlee');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('patchright');
    const env = getEnv();

    // Fetch pages [startPage, startPage + pages); the worker advances the cursor.
    const startPage = Math.max(opts.startPage ?? 0, 0);
    const pages = Math.min(Math.max(opts.pages ?? 3, 1), 10);
    const results: SerpRaw[] = [];
    let blockedPages = 0;

    // A unique queue per call; cross-run continuity comes from ScrapeCursorService.
    const queueName = `serp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const queue = await RequestQueue.open(queueName);
    for (let p = startPage; p < startPage + pages; p++) {
      await queue.addRequest({ url: this.googleUrl(opts.query, p) });
    }

    const crawler = new PlaywrightCrawler({
      requestQueue: queue,
      // Use patchright's stealth, not Crawlee's fingerprints on top.
      launchContext: {
        launcher: chromium,
        launchOptions: { headless: env.SCRAPER_HEADLESS, channel: 'chrome' },
      },
      browserPoolOptions: { useFingerprints: false },
      maxConcurrency: 1,
      maxRequestRetries: 2,
      requestHandlerTimeoutSecs: 90,
      requestHandler: async ({ page, request, session, log }: any) => {
        await page.waitForTimeout(2500 + Math.floor(Math.random() * 1500));
        await this.dismissConsent(page);

        const title = await page.title();
        if (/unusual traffic|not a robot|captcha/i.test(title) || page.url().includes('/sorry/')) {
          blockedPages++;
          session?.retire(); // rotate to a fresh session
          throw new Error('google_block'); // Crawlee retries on that fresh session
        }

        const raw: SerpRaw[] = await page
          .evaluate(() => {
            const items: { title: string; href: string; snippet: string }[] = [];
            document.querySelectorAll('a').forEach((a: any) => {
              const href = a.href || '';
              if (!/linkedin\.com\/in\//i.test(href)) return;
              const h3 = a.querySelector('h3');
              if (!h3) return;
              const container =
                a.closest('div.MjjYud, div.g, div.tF2Cxc') || a.parentElement?.parentElement;
              const sn = container?.querySelector('div.VwiC3b, div[data-sncf], .VwiC3b, span.aCOpRe');
              items.push({ title: h3.textContent || '', href, snippet: sn?.textContent || '' });
            });
            return items;
          })
          .catch(() => [] as SerpRaw[]);

        results.push(...raw);
        const start = request.url.match(/start=(\d+)/)?.[1] ?? '0';
        log.info(`serp start=${start} → ${raw.length} results (raw total ${results.length})`);
      },
      failedRequestHandler: ({ request }: any) => {
        this.logger.warn(`crawlee page failed after retries: ${request.url}`);
      },
    });

    try {
      await crawler.run();
    } catch (err: any) {
      this.logger.warn(`crawlee run error (returning partial): ${err?.message || err}`);
    } finally {
      await crawler.teardown?.().catch(() => undefined);
      await queue.drop?.().catch(() => undefined);
    }

    if (blockedPages) this.logger.warn(`crawlee: ${blockedPages} page(s) hit a Google block`);
    this.logger.log(
      `crawlee fetched ${results.length} raw SERP results across pages ${startPage}..${startPage + pages - 1}`,
    );
    return results;
  }

  private googleUrl(q: string, page: number): string {
    return `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&hl=en&gl=in&start=${page * 10}`;
  }

  private async dismissConsent(page: any): Promise<void> {
    try {
      const btn = page.getByRole('button', { name: /^(Accept all|I agree|Accept|Agree)$/i }).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click().catch(() => undefined);
        await page.waitForTimeout(1200);
      }
    } catch {
      /* no consent wall */
    }
  }
}
