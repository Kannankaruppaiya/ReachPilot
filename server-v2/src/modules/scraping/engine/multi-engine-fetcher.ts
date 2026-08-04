import { Logger } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import { getEnv } from '@/config/env';
import type { SerpRaw } from './crawlee-google-fetcher';

export interface MultiFetchOptions {
  query: string;
  /** First result page index to fetch per engine (the cursor). Default 0. */
  startPage?: number;
  /** How many pages to fetch per engine this run. Default 3, capped at 6. */
  pages?: number;
  /** Stop early once this many unique profile URLs are gathered. */
  target?: number;
}

/** One search engine's config: how to build its URL and read its results. */
interface EngineDef {
  name: string;
  base: string;
  /** Search URL for a zero-based page index. */
  url(query: string, page: number): string;
}

/**
 * Multi-engine SERP fetcher — the resilient upgrade over the single-Google
 * fetchers.
 *
 * WHY
 * ---
 * A single search engine is a single point of failure: once Google shows its
 * "/sorry/" CAPTCHA (deep pagination + repeated runs from one home IP trip it),
 * the whole scrape dies. Different engines run DIFFERENT anti-bot systems with
 * different thresholds, so when Google blocks, Bing / DuckDuckGo / Brave usually
 * still answer. This fetcher:
 *   • rotates across several engines (order from SCRAPER_ENGINES),
 *   • detects a block/CAPTCHA and puts THAT engine on a cooldown (in-memory, so
 *     it also works on the Redis-free VPS), moving on to the next engine,
 *   • aggregates + dedups results across all engines (more breadth, not just
 *     resilience), and
 *   • hardens each session (persistent profile, human-like delays, a scroll and
 *     mouse move, randomized locale/viewport) to look less automated.
 *
 * It still NEVER touches linkedin.com directly — it only reads public SERPs — so
 * a scrape can never get an outreach account banned. patchright is loaded lazily.
 *
 * NOTE: spreading load across engines and keeping each engine shallow reduces the
 * per-engine request rate that triggers blocks, but every engine still egresses
 * from the same IP — a residential/rotating proxy remains the ultimate fix for
 * high volume. This maximizes what's achievable WITHOUT one.
 */
export class MultiEngineFetcher {
  private readonly logger = new Logger(MultiEngineFetcher.name);
  /** engine name → epoch ms until which it is cooling down after a block. */
  private readonly cooldownUntil = new Map<string, number>();

  private static readonly ENGINES: Record<string, EngineDef> = {
    google: {
      name: 'google',
      base: 'https://www.google.com',
      // `num` is deprecated/ignored by Google and reads as an automation tell — omit it.
      url: (q, p) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=in&start=${p * 10}`,
    },
    bing: {
      name: 'bing',
      base: 'https://www.bing.com',
      url: (q, p) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&cc=in&first=${p * 10 + 1}`,
    },
    duckduckgo: {
      name: 'duckduckgo',
      base: 'https://html.duckduckgo.com',
      // The HTML endpoint has a simple, stable DOM and lighter anti-bot than the JS app.
      url: (q, p) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=in-en&s=${p * 30}`,
    },
    brave: {
      name: 'brave',
      base: 'https://search.brave.com',
      url: (q, p) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&offset=${p}&source=web`,
    },
    mojeek: {
      name: 'mojeek',
      base: 'https://www.mojeek.com',
      url: (q, p) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}&s=${p * 10 + 1}`,
    },
  };

  async fetchRaw(opts: MultiFetchOptions): Promise<SerpRaw[]> {
    const env = getEnv();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('patchright');

    const startPage = Math.max(opts.startPage ?? 0, 0);
    const pages = Math.min(Math.max(opts.pages ?? 3, 1), 6);
    const target = Math.max(opts.target ?? 30, 1);

    const order = env.SCRAPER_ENGINES.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => MultiEngineFetcher.ENGINES[s]);
    const engines = order.length ? order : ['google'];

    const bySlug = new Map<string, SerpRaw>();
    const profileDir =
      env.SCRAPER_PROFILE_DIR || path.join(os.tmpdir(), 'reachpilot-scraper-profile');

    let ctx: any;
    try {
      ctx = await this.launch(chromium, profileDir);

      for (const name of engines) {
        if (bySlug.size >= target) break;
        if (this.isCoolingDown(name)) {
          this.logger.log(`  ${name}: cooling down, skipping`);
          continue;
        }
        const eng = MultiEngineFetcher.ENGINES[name];
        let engineHits = 0;

        for (let p = startPage; p < startPage + pages; p++) {
          if (bySlug.size >= target) break;
          const outcome = await this.fetchEnginePage(ctx, eng, opts.query, p);
          if (outcome === 'blocked') {
            this.cooldown(name);
            this.logger.warn(`  ${name}: blocked at page ${p} → cooling down ${env.SCRAPER_ENGINE_COOLDOWN_MS}ms`);
            break; // stop this engine, move to the next
          }
          for (const row of outcome) {
            const slug = this.slugOf(row.href);
            if (slug && !bySlug.has(slug)) {
              bySlug.set(slug, row);
              engineHits++;
            }
          }
          // Human-like gap between page loads.
          await this.sleep(1400 + Math.floor(Math.random() * 2200));
        }
        this.logger.log(`  ${name}: +${engineHits} unique profiles (running total ${bySlug.size})`);
      }
    } catch (err: any) {
      this.logger.warn(`multi-engine fetch error (returning partial): ${err?.message || err}`);
    } finally {
      await ctx?.close().catch(() => undefined);
    }

    const results = [...bySlug.values()];
    this.logger.log(`multi-engine fetched ${results.length} unique raw profiles across ${engines.length} engine(s)`);
    return results;
  }

  /** Fetch one page from one engine. Returns rows, or 'blocked' on a CAPTCHA wall. */
  private async fetchEnginePage(
    ctx: any,
    eng: EngineDef,
    query: string,
    page: number,
  ): Promise<SerpRaw[] | 'blocked'> {
    const pg = await ctx.newPage();
    try {
      await pg.goto(eng.url(query, page), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await pg.waitForTimeout(2200 + Math.floor(Math.random() * 1600));
      await this.dismissConsent(pg);
      await this.humanize(pg);

      const title = (await pg.title().catch(() => '')) || '';
      const url = pg.url();
      const bodyText = await pg.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '');
      if (this.looksBlocked(url, title, bodyText)) return 'blocked';

      // Generic extraction: every anchor + its container text. We resolve the real
      // target URL (many engines wrap results in redirect links) in Node below.
      const anchors: { href: string; text: string; snippet: string }[] = await pg
        .evaluate(() => {
          const out: { href: string; text: string; snippet: string }[] = [];
          document.querySelectorAll('a[href]').forEach((a: any) => {
            const href = a.getAttribute('href') || a.href || '';
            const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || text.length < 2) return;
            const box = a.closest('li, article, div');
            const snippet = box ? (box.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400) : '';
            out.push({ href, text, snippet });
          });
          return out;
        })
        .catch(() => [] as { href: string; text: string; snippet: string }[]);

      const rows: SerpRaw[] = [];
      const seen = new Set<string>();
      for (const a of anchors) {
        const real = this.resolveHref(eng, a.href);
        if (!/linkedin\.com\/in\//i.test(real)) continue;
        const slug = this.slugOf(real);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        rows.push({
          title: a.text.replace(/\s*[|–-]\s*LinkedIn.*$/i, '').trim(),
          href: real,
          snippet: a.snippet,
        });
      }
      return rows;
    } catch (err: any) {
      this.logger.warn(`  ${eng.name} page ${page} failed: ${err?.message || err}`);
      return [];
    } finally {
      await pg.close().catch(() => undefined);
    }
  }

  /** Decode engine redirect wrappers to the real destination URL. */
  private resolveHref(eng: EngineDef, href: string): string {
    if (!href) return '';
    try {
      let u = href.startsWith('//') ? `https:${href}` : href;
      if (u.startsWith('/')) u = eng.base + u;
      const url = new URL(u);

      // Google: /url?q=<real>
      if (url.hostname.includes('google.') && url.pathname === '/url') {
        return url.searchParams.get('q') || url.searchParams.get('url') || u;
      }
      // DuckDuckGo: /l/?uddg=<encoded real>
      if (url.hostname.includes('duckduckgo.com') && url.pathname.startsWith('/l/')) {
        const uddg = url.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
      }
      // Bing: /ck/a?...&u=a1<base64url of real>
      if (url.hostname.includes('bing.com') && url.pathname.startsWith('/ck/a')) {
        const uParam = url.searchParams.get('u');
        if (uParam && uParam.startsWith('a1')) {
          const b64 = uParam.slice(2).replace(/-/g, '+').replace(/_/g, '/');
          try {
            const decoded = Buffer.from(b64, 'base64').toString('utf8');
            if (decoded) return decoded;
          } catch {
            /* fall through */
          }
        }
      }
      return u;
    } catch {
      return href;
    }
  }

  private looksBlocked(url: string, title: string, bodyText: string): boolean {
    if (url.includes('/sorry/')) return true;
    const t = `${title} ${bodyText}`.toLowerCase();
    return /unusual traffic|are you a robot|not a robot|verify (you.?re |that you are )?a? ?human|recaptcha|hcaptcha|solve the (captcha|challenge)|automated queries|detected an anomaly|access denied|too many requests|blocked for/i.test(
      t,
    );
  }

  /** Light human simulation to reduce automation signals before scraping. */
  private async humanize(pg: any): Promise<void> {
    try {
      await pg.mouse.move(120 + Math.random() * 500, 140 + Math.random() * 300).catch(() => undefined);
      await pg.evaluate(() => window.scrollBy(0, 300 + Math.floor(Math.random() * 900))).catch(() => undefined);
      await pg.waitForTimeout(500 + Math.floor(Math.random() * 900));
    } catch {
      /* non-fatal */
    }
  }

  private isCoolingDown(engine: string): boolean {
    const until = this.cooldownUntil.get(engine);
    return !!until && until > Date.now();
  }

  private cooldown(engine: string): void {
    this.cooldownUntil.set(engine, Date.now() + getEnv().SCRAPER_ENGINE_COOLDOWN_MS);
  }

  private slugOf(url: string): string {
    return (url.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] || '').toLowerCase();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Launch a stealth Chrome; fall back to bundled Chromium if the channel is absent. */
  private async launch(chromium: any, profileDir: string): Promise<any> {
    const env = getEnv();
    const locales = ['en-IN', 'en-GB', 'en-US'];
    const locale = locales[Math.floor(Math.random() * locales.length)];
    const base = {
      headless: env.SCRAPER_HEADLESS,
      viewport: null as any,
      locale,
      timezoneId: 'Asia/Kolkata',
    };
    try {
      return await chromium.launchPersistentContext(profileDir, { ...base, channel: 'chrome' });
    } catch (err: any) {
      this.logger.warn(`chrome channel unavailable (${err?.message}); using bundled Chromium`);
      return chromium.launchPersistentContext(profileDir, base);
    }
  }

  private async dismissConsent(pg: any): Promise<void> {
    try {
      const btn = pg
        .getByRole('button', {
          name: /^(Accept all|I agree|Accept|Agree|Got it|Consent|Reject all|Ich stimme zu)$/i,
        })
        .first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click().catch(() => undefined);
        await pg.waitForTimeout(1200);
      }
    } catch {
      /* no consent wall */
    }
  }
}
