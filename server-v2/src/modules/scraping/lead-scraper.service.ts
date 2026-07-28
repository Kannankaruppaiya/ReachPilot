import { Injectable, Logger } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import { getEnv } from '@/config/env';

/** A single normalized profile parsed from a public search result. */
export interface ScrapedLead {
  name: string;
  firstName: string;
  title: string;
  company: string;
  location: string;
  linkedinUrl: string;
  snippet: string;
}

export interface SearchOptions {
  titles: string[];
  location?: string;
  maxResults?: number;
}

/**
 * Free, local lead scraper. Instead of paying Apify per profile (and hitting the
 * free-tier run limit), this queries a public search engine for LinkedIn profile
 * results and parses the SERP cards — the same signal our Apify rag-web-browser
 * fallback used, run locally with no credits.
 *
 * Plain HTTP and headless browsers get bot-blocked (Google/Bing/DuckDuckGo all
 * return CAPTCHA challenges). So it drives **patchright** — a drop-in Playwright
 * fork that patches the CDP/webdriver leaks bot-detectors look for — as a HEADFUL
 * real-Chrome session, which passes Google's checks even from a plain home IP.
 * (Add a residential proxy later, per account, when scaling volume.)
 *
 * It NEVER touches a LinkedIn account session or scrapes linkedin.com directly
 * (that authwalls and risks the account) — it only reads Google results, so a
 * scrape run can never get an outreach account banned.
 *
 * patchright is CommonJS-friendly but loaded lazily so a missing browser channel
 * can't break worker boot.
 */
@Injectable()
export class LeadScraperService {
  private readonly logger = new Logger(LeadScraperService.name);

  /** LinkedIn-scoped boolean query, e.g. ("Finance Head" OR "Finance Manager") "Tamil Nadu" site:linkedin.com/in */
  private buildQuery(titles: string[], location?: string): string {
    const titleExpr = titles
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(' OR ');
    const loc = location?.trim() ? ` "${location.trim()}"` : '';
    return `(${titleExpr})${loc} site:linkedin.com/in`;
  }

  /** Keep only real /in/<slug> profile URLs, normalized to https + no query/hash. */
  private cleanProfileUrl(url: string): string | null {
    if (!url || !/linkedin\.com\/in\//i.test(url)) return null;
    const slug = url.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
    if (!slug) return null;
    const sub = url.match(/\/\/([a-z]{2}\.)?linkedin\.com/i)?.[1] || '';
    return `https://${sub}linkedin.com/in/${slug}`;
  }

  /**
   * Parse a LinkedIn SERP title + snippet into a lead. Titles read like
   * "Ramasamy Soundararajan - Finance Head" (optionally "... | LinkedIn"); the
   * snippet usually carries "Role · Company ... City, Tamil Nadu, India".
   */
  private parseResult(rawTitle: string, snippet: string, url: string): ScrapedLead | null {
    const linkedinUrl = this.cleanProfileUrl(url);
    if (!linkedinUrl) return null;

    const cleanTitle = (rawTitle || '').replace(/\s*[|–-]\s*LinkedIn\s*$/i, '').trim();
    const parts = cleanTitle.split(/\s+[-–—]\s+/);
    const name = (parts[0] || '').trim();
    if (!name || name.length > 60) return null;

    let title = (parts[1] || '').trim();
    if (!title && snippet) title = snippet.split(/[·.|\n]/)[0].trim().slice(0, 80);

    const loc = (snippet || '').match(/([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?,\s*[A-Z][a-zA-Z ]+,\s*India)/);
    const location = loc ? loc[1].trim() : '';

    let company = '';
    if (snippet) {
      const afterRole = snippet.replace(/^[^·.|]*[·.|]\s*/, '');
      company = afterRole.split(/[·.|,\n]/)[0].trim().slice(0, 80);
      if (/followers|connections|^\d/.test(company)) company = '';
    }

    return {
      name,
      firstName: name.split(/\s+/)[0] || '',
      title,
      company,
      location,
      linkedinUrl,
      snippet: (snippet || '').trim().slice(0, 300),
    };
  }

  /**
   * Search Google for LinkedIn profiles matching the titles + location and return
   * up to `maxResults` unique, parsed leads. Best-effort: a blocked/empty load
   * returns whatever was gathered rather than throwing.
   */
  async search(opts: SearchOptions): Promise<ScrapedLead[]> {
    const env = getEnv();
    const maxResults = Math.min(Math.max(opts.maxResults ?? 15, 1), 100);
    const query = this.buildQuery(opts.titles, opts.location);
    this.logger.log(`Scraping Google for "${query}" (target ${maxResults})`);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('patchright');
    const profileDir =
      env.SCRAPER_PROFILE_DIR || path.join(os.tmpdir(), 'reachpilot-scraper-profile');

    let ctx: any;
    const byUrl = new Map<string, ScrapedLead>();
    try {
      ctx = await this.launch(chromium, profileDir);
      const page = ctx.pages()[0] || (await ctx.newPage());

      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=en&gl=in`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
      await this.dismissConsent(page);

      // Pull title / href / snippet from each result whose link is a profile. The
      // result <a> is the only linkedin/in anchor that also wraps an <h3>.
      const raw: { title: string; href: string; snippet: string }[] = await page
        .evaluate(() => {
          const items: { title: string; href: string; snippet: string }[] = [];
          document.querySelectorAll('a').forEach((a) => {
            const href = (a as HTMLAnchorElement).href || '';
            if (!/linkedin\.com\/in\//i.test(href)) return;
            const h3 = a.querySelector('h3');
            if (!h3) return;
            const container =
              a.closest('div.MjjYud, div.g, div.tF2Cxc') || a.parentElement?.parentElement;
            const sn = container?.querySelector(
              'div.VwiC3b, div[data-sncf], .VwiC3b, span.aCOpRe',
            );
            items.push({
              title: h3.textContent || '',
              href,
              snippet: sn?.textContent || '',
            });
          });
          return items;
        })
        .catch(() => [] as any[]);

      for (const r of raw) {
        const lead = this.parseResult(r.title, r.snippet, r.href);
        if (lead && !byUrl.has(lead.linkedinUrl)) byUrl.set(lead.linkedinUrl, lead);
      }
      this.logger.log(`  parsed ${byUrl.size} unique profiles from ${raw.length} result links`);
    } catch (err: any) {
      this.logger.warn(`Scrape error (returning partial): ${err?.message || err}`);
    } finally {
      await ctx?.close().catch(() => undefined);
    }

    const region = opts.location?.trim() || '';
    return [...byUrl.values()]
      .slice(0, maxResults)
      .map((l) => ({ ...l, location: l.location || region }));
  }

  /** Launch a stealth Chrome; fall back to bundled Chromium if the channel is absent. */
  private async launch(chromium: any, profileDir: string): Promise<any> {
    const env = getEnv();
    const headless = env.SCRAPER_HEADLESS; // default false — headful passes Google's checks
    const base = { headless, viewport: null as any };
    try {
      return await chromium.launchPersistentContext(profileDir, { ...base, channel: 'chrome' });
    } catch (err: any) {
      this.logger.warn(`chrome channel unavailable (${err?.message}); using bundled Chromium`);
      return chromium.launchPersistentContext(profileDir, base);
    }
  }

  /** Google occasionally gates results behind a consent wall — accept it to reach results. */
  private async dismissConsent(page: any): Promise<void> {
    try {
      const btn = page
        .getByRole('button', { name: /^(Accept all|I agree|Accept|Agree)$/i })
        .first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click().catch(() => undefined);
        await page.waitForTimeout(1500);
      }
    } catch {
      /* no consent wall */
    }
  }
}
