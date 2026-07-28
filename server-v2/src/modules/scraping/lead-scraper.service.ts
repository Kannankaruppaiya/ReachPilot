import { Injectable, Logger } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import { getEnv } from '@/config/env';
import { AiService, ExtractedProfile } from '@/modules/ai/ai.service';

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

  constructor(private readonly ai: AiService) {}

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

  /* ---------------- data-quality guards (kill false leads) ---------------- */

  // Company/entity markers — a "name" containing these is not a person.
  private static readonly NAME_JUNK =
    /\b(ltd|pvt|private|limited|llp|inc|corp|co\.|company|solutions?|technolog|group|industries|enterprises?|global|consult|services?|systems?|ventures?|associates?|at)\b/i;
  // Role words — used to detect a "name" that is really just a job title.
  private static readonly ROLE_WORDS =
    /\b(head|manager|director|officer|cfo|ceo|coo|cto|vp|president|lead|analyst|accountant|executive|specialist|controller|finance|accounts|hr|sales|marketing|engineer|founder|owner|partner)\b/i;
  private static readonly IN_STATES = [
    'tamil nadu', 'kerala', 'karnataka', 'andhra pradesh', 'telangana', 'maharashtra',
    'gujarat', 'delhi', 'punjab', 'haryana', 'rajasthan', 'west bengal', 'uttar pradesh',
    'madhya pradesh', 'bihar', 'odisha', 'assam', 'goa', 'jharkhand', 'chhattisgarh',
  ];

  /** The /in/<slug> handle, lowercased — the stable dedup key (subdomain-agnostic). */
  private slugOf(url: string): string {
    return (url.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] || '').toLowerCase();
  }

  /** Strip honorifics/certs, fix ALL-CAPS, collapse whitespace. */
  private normalizeName(raw: string): string {
    let n = (raw || '').trim().replace(/\s*\|\s*LinkedIn\s*$/i, '');
    n = n.replace(/^(mr|mrs|ms|dr|er|ca|cma|cfa|prof)\.?\s+/i, ''); // leading honorific/cert
    n = n.split(',')[0].trim(); // drop trailing ", CA, MBA" clauses
    if (n && n === n.toUpperCase()) n = n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    return n.replace(/\s{2,}/g, ' ').trim();
  }

  /** A plausible real person name — not a company, role, or headline. */
  private isPersonName(name: string): boolean {
    const n = (name || '').trim();
    if (!n || n.length > 45) return false;
    const words = n.split(/\s+/);
    if (words.length > 5) return false; // headlines are long
    if (LeadScraperService.NAME_JUNK.test(n)) return false; // company markers / "at"
    if (!/[a-zA-Z]{2,}/.test(n)) return false; // pure handle/number
    // Reject a "name" made entirely of role words ("Head Of Finance").
    const nonRole = words.filter(
      (w) => !LeadScraperService.ROLE_WORDS.test(w) && !/^(of|the|and|&|-)$/i.test(w),
    );
    return nonRole.length > 0;
  }

  /** Does the extracted title share a real keyword with what the user asked for? */
  private titleRelevant(title: string, requested: string[]): boolean {
    const t = (title || '').toLowerCase();
    if (!t) return true; // empty title — don't drop on this axis
    const stop = new Set([
      'of', 'the', 'and', 'a', 'for', 'to', 'in', 'at', 'senior', 'junior', 'lead',
      'head', 'sr', 'jr', 'assistant', 'deputy', 'general', 'manager', 'director',
    ]);
    const kws = new Set<string>();
    for (const req of requested)
      for (const w of req.toLowerCase().split(/\W+/)) if (w.length > 2 && !stop.has(w)) kws.add(w);
    if (!kws.size) return true; // titles were only generic words
    for (const w of t.split(/\W+/)) if (kws.has(w)) return true;
    return false;
  }

  /** Keep a field only if it is actually grounded in the source text (anti-hallucination). */
  private grounded(value: string, source: string): string {
    const v = (value || '').trim();
    if (!v) return '';
    const src = (source || '').toLowerCase();
    const words = v.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    if (!words.length) return v;
    const hit = words.filter((w) => src.includes(w)).length;
    return hit / words.length >= 0.6 ? v : '';
  }

  /** True unless the location clearly names a DIFFERENT state/country than requested. */
  private locationOk(loc: string, requested?: string): boolean {
    const l = (loc || '').toLowerCase();
    const req = (requested || '').toLowerCase();
    if (!l || !req) return true;
    if (l.includes(req) || req.includes(l)) return true;
    const reqState = LeadScraperService.IN_STATES.find((s) => req.includes(s));
    const locState = LeadScraperService.IN_STATES.find((s) => l.includes(s));
    if (reqState && locState && reqState !== locState) return false; // different Indian state
    if (req.includes('india') && /\b(usa|uk|uae|dubai|singapore|canada|australia|germany|qatar|saudi|nigeria)\b/.test(l))
      return false; // foreign vs an India request
    return true; // lenient (e.g. "Chennai" for "Tamil Nadu")
  }

  /**
   * The anti-false gate: normalize + validate every candidate, ground its fields
   * against the original SERP text, drop non-persons / off-target titles /
   * wrong-region leads, and dedup by profile slug (subdomain-agnostic).
   */
  private validateClean(
    cands: (ScrapedLead & { sourceText: string })[],
    opts: SearchOptions,
  ): ScrapedLead[] {
    const bySlug = new Map<string, ScrapedLead>();
    let dropped = 0;
    for (const c of cands) {
      const slug = this.slugOf(c.linkedinUrl);
      if (!slug || bySlug.has(slug)) continue;

      const name = this.normalizeName(c.name);
      if (!this.isPersonName(name)) { dropped++; continue; } // #1/#7/#8 role-as-name
      if (!this.titleRelevant(c.title, opts.titles)) { dropped++; continue; } // #2 off-target

      const company = this.grounded(c.company, c.sourceText); // #4 anti-hallucination
      const location = this.grounded(c.location, c.sourceText);
      if (location && !this.locationOk(location, opts.location)) { dropped++; continue; } // #3 wrong region

      bySlug.set(slug, {
        name,
        firstName: name.split(/\s+/)[0] || '',
        title: c.title.trim(),
        company,
        location,
        linkedinUrl: c.linkedinUrl,
        snippet: c.snippet,
      });
    }
    if (dropped) this.logger.log(`  validation dropped ${dropped} false/low-quality candidates`);
    return [...bySlug.values()];
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
    const candidates: (ScrapedLead & { sourceText: string })[] = [];
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

      // Clean the messy SERP snippets with one batched Gemini call, then merge
      // PER-URL with the regex parse — a partial/failed AI extraction never loses
      // leads (missed URLs fall back to regex). Both feed the validation gate.
      const extracted = await this.ai.extractProfiles(
        raw.map((r) => ({ title: r.title, snippet: r.snippet, url: r.href })),
      );
      const aiBySlug = new Map<string, ExtractedProfile>();
      for (const p of extracted || []) {
        const slug = this.slugOf(p.linkedinUrl);
        if (slug && !aiBySlug.has(slug)) aiBySlug.set(slug, p);
      }
      for (const r of raw) {
        const cleanUrl = this.cleanProfileUrl(r.href);
        if (!cleanUrl) continue;
        const sourceText = `${r.title} ${r.snippet}`;
        const ai = aiBySlug.get(this.slugOf(cleanUrl));
        if (ai) {
          candidates.push({
            name: ai.name,
            firstName: '',
            title: ai.title,
            company: ai.company,
            location: ai.location,
            linkedinUrl: cleanUrl,
            snippet: r.snippet.trim().slice(0, 300),
            sourceText,
          });
        } else {
          const reg = this.parseResult(r.title, r.snippet, r.href);
          if (reg) candidates.push({ ...reg, sourceText });
        }
      }
      this.logger.log(
        `  ${candidates.length} candidates (${aiBySlug.size} AI-clean, rest regex) from ${raw.length} results`,
      );
    } catch (err: any) {
      this.logger.warn(`Scrape error (returning partial): ${err?.message || err}`);
    } finally {
      await ctx?.close().catch(() => undefined);
    }

    const region = opts.location?.trim() || '';
    const clean = this.validateClean(candidates, opts);
    this.logger.log(`Scrape done: ${clean.length} valid leads (of ${candidates.length} candidates)`);
    return clean.slice(0, maxResults).map((l) => ({ ...l, location: l.location || region }));
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
