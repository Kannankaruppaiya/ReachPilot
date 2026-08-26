import { Injectable, Logger } from '@nestjs/common';
import type { BrowserContext, Page, Locator } from 'playwright';
import { authenticator } from 'otplib';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getEnv } from '@/config/env';
import {
  LinkedInDriver,
  LinkedInActionContext,
  LinkedInActionResult,
  LinkedInLoginContext,
  LinkedInLoginResult,
  LinkedInSyncResult,
  ProxyConfig,
  LinkedInFingerprint,
} from './linkedin-driver.interface';
import { CONNECT_NAME, SELECTORS, resolveFirst, type SelectorScope } from './linkedin-selectors';
import {
  parseStoredSession,
  cookiesToInject,
  classifyPinChallenge,
  type StoredCookie,
} from './linkedin-session-store';
import { classifyLoginForm, rememberedAccountMatches } from './linkedin-login-form';

/* ---------------- human-like helpers ---------------- */

const rnd = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Randomized "think time" between actions — humans are noisy, bots are periodic. */
const think = () => sleep(rnd(1500, 5000));

/** The `/in/<slug>` segment of a LinkedIn profile URL, verbatim (no case change). */
export const slugOf = (u: string): string => u.match(/\/in\/([^/?#]+)/i)?.[1] || '';
/**
 * The `vanityName` query parameter of a LinkedIn custom-invite deep-link
 * ("/preload/custom-invite/?vanityName=<slug>"), verbatim (no case change,
 * no decoding) — the SAME normalised shape `slugOf` produces, so both feed
 * `profileKey` identically. On the fast confirm path (toast / Pending flip),
 * the page never navigates back to an `/in/<slug>` URL — this is the only
 * slug LinkedIn has handed us at that point, and it's already on the current
 * URL, so no extra navigation is needed to read it.
 */
export const vanityNameOf = (u: string): string => u.match(/[?&]vanityName=([^&]+)/i)?.[1] || '';
/**
 * The slug a CONFIRMED invite resolved to, read from whatever URL the page is
 * sitting on — `/in/<slug>` if we navigated back to a profile (the slow
 * "reload and check" confirmation), otherwise the custom-invite deep-link's
 * `vanityName`. Returns '' when the URL carries neither.
 *
 * This is a named export rather than an inline `||` at the call site so the
 * fallback is directly testable: with the expression inlined, deleting
 * `|| vanityNameOf(...)` left `test/resolved-slug-fallback.spec.ts` green,
 * because the spec could only assert against its own copy of the logic. That
 * fallback is the ONLY thing producing a cross-form key on the fast path.
 *
 * Reads the CURRENT url — it never navigates.
 */
export const resolvedSlugFrom = (url: string): string => slugOf(url) || vanityNameOf(url);
/**
 * True for LinkedIn's OBFUSCATED member-URN profile slug ("ACwAAC551Qg…") as
 * opposed to a vanity slug. Scrapers emit this form; LinkedIn serves the profile
 * but canonicalises the URL to the vanity, so the URN can never match the Connect
 * anchor's `vanityName` and must not be used as a target-identity guard.
 * Vanity slugs are lowercase, so the mixed-case "AC?AA" + base64url shape is
 * unambiguous — real lowercase slugs like "acamahalakshmi" do NOT match.
 */
export const isOpaqueSlug = (s: string): boolean => /^AC[A-Za-z0-9]AA[A-Za-z0-9_-]{20,}$/.test(s);

async function typeLikeHuman(page: Page, selector: string, text: string): Promise<void> {
  // Pick the first VISIBLE match (LinkedIn ships hidden duplicate inputs).
  const el = page.locator(selector).filter({ visible: true }).first();
  await el.waitFor({ state: 'visible', timeout: 15000 });
  await el.click();
  for (const ch of text) {
    await el.type(ch, { delay: rnd(45, 165) });
    if (Math.random() < 0.06) await sleep(rnd(120, 400)); // occasional pause
  }
}

async function humanScroll(page: Page): Promise<void> {
  const steps = rnd(2, 5);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, rnd(200, 600));
    await sleep(rnd(300, 900));
  }
}

/* ---------------- navigation on a slow link ---------------- */

/** Budget for committing a profile navigation (response headers only). */
const NAV_COMMIT_TIMEOUT_MS = 45_000;
/** Budget for the page to become USABLE once the navigation has committed. */
const NAV_READY_TIMEOUT_MS = 45_000;
/** Navigation attempts. Two, because packet loss drops the odd request outright. */
const NAV_ATTEMPTS = 2;
/**
 * How long the lazily-hydrated top-card action bar gets to appear. Raised from
 * 12 s: on a slow link those buttons arrive by XHR well after the HTML, and a
 * premature scan reports a false `no_connect_button` — which is TERMINAL, so a
 * momentary slowdown permanently burned the lead.
 */
const ACTION_BAR_TIMEOUT_MS = 30_000;

/** The bit of a navigation response {@link gotoProfile} reads. */
export interface NavResponse {
  status(): number;
}
/**
 * The slice of a Playwright `Page` that {@link gotoProfile} touches. A real
 * `Page` satisfies it structurally, and so does a plain object — which is what
 * makes the navigation policy unit-testable without launching a browser.
 */
export interface NavigablePage {
  goto(url: string, opts: { waitUntil: 'commit'; timeout: number }): Promise<NavResponse | null>;
  waitForLoadState(state: 'domcontentloaded', opts: { timeout: number }): Promise<void>;
  locator(selector: string): {
    first(): { waitFor(opts: { state: 'attached'; timeout: number }): Promise<void> };
  };
}

/**
 * Navigate to a LinkedIn profile over a link that may be SLOW.
 *
 * The previous gate — `waitUntil: 'domcontentloaded'` with a 30 s cap — was the
 * single biggest source of lost leads on a poor connection. A profile document
 * is 1–2 MB, so at a few tens of kB/s the parse does not FINISH inside 30 s even
 * though the page has already painted and Connect is on screen. Observed live on
 * a 15 kB/s link: the tab visibly showed the target's Connect button while
 * `page.goto` threw `Timeout 30000ms exceeded`, the driver's `finally` closed the
 * context (the "tab closes by itself" symptom), and a good lead was recorded as
 * failed.
 *
 * Document-complete is simply the wrong signal — what the caller needs is a
 * rendered body. So: commit the navigation (headers only, unaffected by a slow
 * tail), then wait on that real condition with a generous budget. Neither wait is
 * fatal on its own, so a slow tail can no longer fail a page that has rendered.
 *
 * Callers must use this only for the FIRST navigation of an action: a failure
 * here proves nothing was clicked and nothing was sent, which is exactly what
 * makes re-driving a `network_error` safe.
 */
export async function gotoProfile(
  page: NavigablePage,
  url: string,
  onRetry?: (reason: string) => void,
): Promise<{ resp: NavResponse | null; error?: string }> {
  let lastErr = '';
  for (let attempt = 0; attempt < NAV_ATTEMPTS; attempt++) {
    if (attempt) {
      onRetry?.(lastErr);
      await sleep(rnd(2000, 5000));
    }
    let resp: NavResponse | null = null;
    try {
      resp = await page.goto(url, { waitUntil: 'commit', timeout: NAV_COMMIT_TIMEOUT_MS });
    } catch (err: any) {
      lastErr = String(err?.message || err).split('\n')[0].trim();
      continue;
    }
    // A 404 is a real answer, not a slow page. Hand it straight back so the
    // caller can classify the profile as gone instead of retrying a dead URL.
    if (resp && resp.status() === 404) return { resp };
    await page
      .waitForLoadState('domcontentloaded', { timeout: NAV_READY_TIMEOUT_MS })
      .catch(() => undefined);
    const rendered = await page
      .locator('main, h1')
      .first()
      .waitFor({ state: 'attached', timeout: NAV_READY_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (rendered) return { resp };
    lastErr = 'body never rendered';
  }
  return { resp: null, error: lastErr || 'navigation_failed' };
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------------- driver ---------------- */

/**
 * Real LinkedIn automation via a headless Chromium session.
 *
 * Every call: launch → build an account-pinned context (proxy + cookie +
 * matching timezone/locale + stealth patches) → act like a human with a
 * selector cascade → detect checkpoints → classify the outcome → tear down.
 *
 * Nothing stays running between jobs; the "logged-in" state lives in the
 * stored li_at cookie, which is re-injected each time.
 */
@Injectable()
export class PlaywrightLinkedInDriver implements LinkedInDriver {
  private readonly logger = new Logger(PlaywrightLinkedInDriver.name);
  private redis?: Redis;

  private getRedis(): Redis {
    if (!this.redis) {
      // ioredis enables TLS automatically for rediss:// (Upstash) URLs.
      this.redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    }
    return this.redis;
  }

  /**
   * Account-level browser mutex.
   *
   * A LinkedIn account has ONE persistent profile dir, and Chromium refuses to
   * open a profile that another instance already holds. Several things open an
   * account's browser — connect/message actions, the every-5-min sync poll, the
   * stale-invite withdrawer — and with more than one worker process they collide,
   * failing with "Opening in existing browser session". A distributed lock keyed
   * on the account guarantees exactly one live browser per account across every
   * worker and operation. Callers that can't acquire it back off and retry later
   * (the scheduler re-runs the job) instead of corrupting the profile.
   */
  private async acquireBrowserLock(
    accountId?: string,
  ): Promise<{ release: () => Promise<void> }> {
    if (!accountId) return { release: async () => undefined };
    const redis = this.getRedis();
    const key = `linkedin:browser:lock:${accountId}`;
    const token = randomUUID();
    const ttlMs = 180_000; // auto-expires so a crashed worker can't hold it forever
    const deadline = Date.now() + 75_000; // wait up to ~75s for the other op to finish

    for (;;) {
      const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
      if (ok) {
        return {
          release: async () => {
            // Compare-and-delete so we never release a lock we no longer own
            // (e.g. if ours expired and another worker re-acquired it).
            const lua =
              "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
            await redis.eval(lua, 1, key, token).catch(() => undefined);
          },
        };
      }
      if (Date.now() > deadline) {
        throw new Error('BROWSER_BUSY: account browser in use by another operation');
      }
      await sleep(rnd(1200, 2800));
    }
  }

  /**
   * Click a control robustly. LinkedIn buttons can be found in the accessibility
   * tree yet not respond to a plain click — a sticky header overlays them, the
   * hit-target is a child span, or an animation leaves them briefly unstable.
   *
   * Escalation order (safest → riskiest):
   *   1. normal click        — full actionability + hit-test (won't hit an overlay)
   *   2. scroll-to-center + normal click — fixes the sticky-header-overlap case
   *   3. in-page DOM .click() — fires the event ON the resolved element, no coords
   *   4. force click         — LAST resort; skips checks and clicks by COORDINATE,
   *                            so it's the one that can land in the wrong place.
   * DOM click precedes force precisely because force-by-coordinate is what caused
   * "clicked somewhere else" misfires. Returns whether any strategy landed.
   */
  private async robustClick(loc: Locator, timeoutMs = 8000): Promise<boolean> {
    try {
      await loc.click({ timeout: timeoutMs });
      return true;
    } catch {
      /* try harder */
    }
    try {
      // Center the element so a sticky header/nav isn't overlapping the top of it.
      await loc.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' }));
      await loc.click({ timeout: 5000 });
      return true;
    } catch {
      /* try harder */
    }
    try {
      // Precise: dispatch the click on the exact element, independent of coords.
      await loc.evaluate((el) => (el as HTMLElement).click());
      return true;
    } catch {
      /* try harder */
    }
    try {
      await loc.click({ force: true, timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /* ---- context lifecycle ---- */

  /** Persistent profile dir per account → LinkedIn "remembers" the device
   *  (cookies/cache/localStorage survive) → far fewer 2FA/checkpoint prompts. */
  private profileDir(accountId?: string): string {
    const dir = path.join(os.tmpdir(), 'reachpilot-profiles', accountId || 'default');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Remove stale Chromium single-instance locks from an account's profile.
   *
   * A persistent context leaves `SingletonLock`/`SingletonCookie`/`SingletonSocket`
   * (and a nested `lockfile`) behind when its process is killed or crashes
   * mid-action instead of closing cleanly. On the next launch Chromium sees the
   * lock and refuses with "Opening in existing browser session", which then fails
   * EVERY job for that account until the file is cleared by hand — a single worker
   * restart would otherwise brick automation account-wide.
   *
   * Actions on one account are serialized (worker concurrency=1 + inter-action
   * spacing), so a lock present at launch is always a stale leftover, never a live
   * concurrent session — safe to remove so the account self-heals.
   */
  private clearStaleProfileLocks(dir: string): void {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
      } catch {
        /* best-effort; a missing lock is the normal case */
      }
    }
  }

  /**
   * Open a stealthy, account-pinned PERSISTENT browser context:
   *  - per-account profile (device recognition)
   *  - real Chrome channel (bundled Chromium is more detectable) w/ fallback
   *  - proxy + geo-matched locale/timezone + Accept-Language
   *  - comprehensive fingerprint patches (webdriver, chrome, WebGL, plugins…)
   */
  private async openAccountContext(opts: {
    accountId?: string;
    proxy?: ProxyConfig;
    fingerprint?: LinkedInFingerprint;
    li_at?: string;
    cookies?: StoredCookie[];
  }): Promise<BrowserContext> {
    const { chromium } = await import('playwright');
    const env = getEnv();
    const fp = opts.fingerprint || {};
    const locale = fp.locale || 'en-US';
    const langs = [locale, locale.split('-')[0]];

    const launchOpts: any = {
      headless: env.PLAYWRIGHT_HEADLESS,
      slowMo: env.PLAYWRIGHT_SLOWMO_MS || undefined,
      proxy: opts.proxy
        ? { server: opts.proxy.server, username: opts.proxy.username, password: opts.proxy.password }
        : undefined,
      userAgent: fp.userAgent || DEFAULT_UA,
      locale,
      timezoneId: fp.timezoneId || 'UTC', // MUST match proxy geo
      viewport: fp.viewport || { width: 1366, height: 768 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      extraHTTPHeaders: { 'Accept-Language': `${langs[0]},${langs[1]};q=0.9` },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    };

    // One live browser per account, across every worker and operation. Throws
    // BROWSER_BUSY if another op holds it past the wait window — the caller then
    // fails cleanly and the scheduler retries, instead of colliding on the profile.
    const lock = await this.acquireBrowserLock(opts.accountId);

    const dir = this.profileDir(opts.accountId);
    // Self-heal after an unclean shutdown: drop any stale single-instance lock
    // so a killed/crashed previous run doesn't block every future action.
    this.clearStaleProfileLocks(dir);
    let context: BrowserContext;
    try {
      try {
        // Real Google Chrome looks far less like automation than bundled Chromium.
        context = await chromium.launchPersistentContext(dir, { ...launchOpts, channel: 'chrome' });
      } catch {
        context = await chromium.launchPersistentContext(dir, launchOpts);
      }
    } catch (err) {
      // Launch itself failed — don't strand the lock.
      await lock.release();
      throw err;
    }

    // Release the account lock whenever the context closes (every action closes
    // it in a finally), so the next queued operation for this account can run.
    const origClose = context.close.bind(context);
    let released = false;
    (context as unknown as { close: BrowserContext['close'] }).close = async (...args: unknown[]) => {
      try {
        return await (origClose as (...a: unknown[]) => Promise<void>)(...args);
      } finally {
        if (!released) {
          released = true;
          await lock.release();
        }
      }
    };

    await this.applyStealth(context, langs);

    // Restore the stored session ONLY into a profile that has none.
    //
    // The old code injected our stored `li_at` unconditionally, over whatever the
    // profile already had. That is backwards: the profile's cookie is what
    // LinkedIn last handed THIS browser, while the vault's was captured at the
    // last login and never refreshed. Observed live — the two had diverged, and
    // the injection replaced a working cookie with a revoked one, so a session
    // the user had just signed in by hand was destroyed by the next job.
    const stored = opts.cookies?.length ? opts.cookies : parseStoredSession(opts.li_at);
    if (stored.length) {
      const existing = (await context.cookies('https://www.linkedin.com')) as StoredCookie[];
      const inject = cookiesToInject(existing, stored);
      if (inject.length) {
        await context.addCookies(inject as Parameters<BrowserContext['addCookies']>[0]);
      } else {
        this.logger.log(
          { accountId: opts.accountId },
          'Profile already holds a LinkedIn session — keeping it, not injecting the stored copy',
        );
      }
    }
    return context;
  }

  /** Inject fingerprint-evasion patches before any page script runs. */
  private async applyStealth(context: BrowserContext, languages: string[]): Promise<void> {
    await context.addInitScript((langs: string[]) => {
      // navigator.webdriver → undefined (headless leaks `true`)
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // realistic chrome object
      (window as any).chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };

      // navigator.plugins — real Chrome exposes a live PluginArray of five PDF
      // aliases (each backed by real Plugin objects with a matching MimeType),
      // NOT a bare [1,2,3,4,5] number array. A number array is an obvious
      // headless tell, so build a structurally-correct PluginArray instead.
      try {
        const P: any = (window as any).Plugin?.prototype || Object.prototype;
        const PA: any = (window as any).PluginArray?.prototype || Object.prototype;
        const MT: any = (window as any).MimeType?.prototype || Object.prototype;
        const mkMime = (d: any) => {
          const m = Object.create(MT);
          Object.defineProperties(m, {
            type: { value: d.type, enumerable: true },
            suffixes: { value: d.suffixes, enumerable: true },
            description: { value: d.description, enumerable: true },
          });
          return m;
        };
        const pdfMimes = [
          mkMime({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }),
          mkMime({ type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }),
        ];
        const mkPlugin = (name: string) => {
          const pl = Object.create(P);
          Object.defineProperties(pl, {
            name: { value: name, enumerable: true },
            filename: { value: 'internal-pdf-viewer', enumerable: true },
            description: { value: 'Portable Document Format', enumerable: true },
            length: { value: pdfMimes.length, enumerable: true },
          });
          pdfMimes.forEach((m, i) => (pl[i] = m));
          pl.item = (i: number) => pdfMimes[i] || null;
          pl.namedItem = (t: string) => pdfMimes.find((m) => m.type === t) || null;
          return pl;
        };
        const plugins = [
          'PDF Viewer',
          'Chrome PDF Viewer',
          'Chromium PDF Viewer',
          'Microsoft Edge PDF Viewer',
          'WebKit built-in PDF',
        ].map(mkPlugin);
        const pluginArray = Object.create(PA);
        plugins.forEach((p, i) => (pluginArray[i] = p));
        Object.defineProperty(pluginArray, 'length', { value: plugins.length });
        pluginArray.item = (i: number) => plugins[i] || null;
        pluginArray.namedItem = (n: string) => plugins.find((p: any) => p.name === n) || null;
        pluginArray.refresh = () => undefined;
        Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });
      } catch {
        /* keep going — a missing plugins spoof is less bad than a broken init script */
      }

      // languages + hardware
      Object.defineProperty(navigator, 'languages', { get: () => langs });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      // permissions.query (headless resolves 'denied' oddly)
      try {
        const orig = window.navigator.permissions.query.bind(window.navigator.permissions);
        // @ts-ignore
        window.navigator.permissions.query = (p: any) =>
          p && p.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission } as any)
            : orig(p);
      } catch {
        /* ignore */
      }
      // WebGL vendor/renderer spoof
      try {
        const proto = (WebGLRenderingContext as any).prototype;
        const getParam = proto.getParameter;
        proto.getParameter = function (p: number) {
          if (p === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
          if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
          return getParam.call(this, p);
        };
      } catch {
        /* ignore */
      }
    }, languages);
  }

  /** Inspect the page for CAPTCHA / security challenges. Returns true if blocked. */
  private async isCheckpoint(page: Page): Promise<boolean> {
    const url = page.url();
    if (/checkpoint|challenge|captcha|authwall/i.test(url)) return true;
    const hit = await page
      .locator(
        'text=/security check|verify it.?s you|unusual activity|captcha|confirm your identity/i',
      )
      .count()
      .catch(() => 0);
    return hit > 0;
  }

  /** Lead imports often carry bare "linkedin.com/in/…" URLs (no scheme) —
   *  page.goto rejects those as invalid, so normalize before navigating. */
  private normalizeProfileUrl(url: string): string {
    const u = (url || '').trim();
    if (!u || /^https?:\/\//i.test(u)) return u;
    return 'https://' + u.replace(/^\/+/, '');
  }

  /* ---- actions ---- */

  async sendConnectRequest(
    targetUrl: string,
    message: string,
    ctx?: LinkedInActionContext,
  ): Promise<LinkedInActionResult> {
    targetUrl = this.normalizeProfileUrl(targetUrl);
    if (!ctx?.li_at) return { status: 'failed', error: 'NO_SESSION: account not logged in' };

    let context: BrowserContext | undefined;
    try {
      context = await this.openAccountContext({
        accountId: ctx.accountId,
        proxy: ctx.proxy,
        fingerprint: ctx.fingerprint,
        li_at: ctx.li_at,
        cookies: ctx.cookies,
      });
      const page = context.pages()[0] || (await context.newPage());

      const nav = await gotoProfile(page, targetUrl, (reason) =>
        this.logger.warn({ targetUrl, reason }, 'Profile navigation failed — retrying once'),
      );
      if (nav.error) {
        this.logger.warn(
          { targetUrl, error: nav.error },
          'Profile never loaded — deferring as a network failure (nothing was sent)',
        );
        return { status: 'network_error', error: `nav_failed: ${nav.error}` };
      }
      const resp = nav.resp;
      await think();

      // The /in/<slug> of the INTENDED target — a hard guard on the custom-invite
      // deep-link below. LinkedIn's "People also viewed" / "More profiles" rails
      // carry their OWN custom-invite anchors; a page-wide match once grabbed a
      // rail person's anchor and, across BullMQ retries, fired invites at several
      // wrong people. We only goto a custom-invite whose vanityName is this slug.
      //
      // ⚠️ Scraped leads often carry LinkedIn's OBFUSCATED member-URN form
      // ("/in/ACwAAC551Qg…") instead of the vanity slug. LinkedIn serves the
      // profile fine but canonicalises the URL to the real vanity, so the Connect
      // anchor's vanityName can never equal the pre-redirect ACwAA… string and the
      // guard below aborted EVERY such invite (`connect_target_mismatch` — observed
      // live: requested /in/ACwAAC551Qg…, landed /in/ramcacpa, anchor
      // vanityName=ramcacpa). So: only trust a vanity slug here, and re-read it
      // from the LANDED url once the page settles (below). A vanity targetUrl is
      // unaffected — it resolves exactly as before.
      const requestedSlug = slugOf(targetUrl);
      let targetSlug = isOpaqueSlug(requestedSlug) ? '' : requestedSlug.toLowerCase();

      if (resp && resp.status() === 404) return { status: 'profile_gone' };
      if (await this.isCheckpoint(page)) return { status: 'checkpoint' };

      // Soft-unavailable: LinkedIn often serves a 200 page for deleted /
      // deactivated / restricted / blocked-by-member profiles rather than a 404.
      // Classify it explicitly instead of falling through to "no_connect_button".
      const unavailable = await page
        .locator(
          'text=/this profile is not available|profile.{0,20}not available|page doesn.?t exist|isn.?t available right now|no longer active|this page doesn.?t exist/i',
        )
        .count()
        .catch(() => 0);
      if (unavailable) return { status: 'profile_gone' };

      await humanScroll(page);

      const main = page.locator('main').first();

      // WAIT for the primary action bar to render before scanning. The top-card
      // buttons (Message / Connect / Follow / More / Pending) are lazy-loaded a
      // beat after the profile HTML; scanning too early finds nothing and wrongly
      // reports `no_connect_button`. Wait for ANY primary action to appear.
      await main
        .getByRole('button', { name: /^(Connect|Message|Follow|Following|More|More actions|Pending)$/i })
        .first()
        .waitFor({ state: 'visible', timeout: ACTION_BAR_TIMEOUT_MS })
        .catch(() => undefined);
      await sleep(rnd(500, 1200));

      // We arrived via the opaque member-URN form and the URL has now settled —
      // LinkedIn has canonicalised it to the real vanity, which IS a usable guard.
      // If it somehow did not, targetSlug stays '' and the deep-link shortcut is
      // skipped: the click path then acts on the very locator `namesTarget()`
      // vetted, so identity is still enforced, just without the slug shortcut.
      if (!targetSlug) {
        const landedSlug = slugOf(page.url());
        if (landedSlug && !isOpaqueSlug(landedSlug)) {
          targetSlug = landedSlug.toLowerCase();
          this.logger.log({ requestedSlug, targetSlug }, 'Resolved opaque profile URL to vanity slug');
        }
      }

      // TARGET NAME — read from the PAGE TITLE ("<Name> | LinkedIn", optionally
      // "(N) <Name> | LinkedIn"). This is far more reliable than any DOM selector:
      // class names are hashed and — observed live on this exact bug — the name is
      // NOT dependably an <h1> under <main> (main h1 came back empty while the
      // title correctly held "Beschi Dinesh"). The name is what lets us pick the
      // target's own Connect out of the several "Invite <someone> to connect"
      // buttons the "People also viewed" rails also render.
      const pageTitle = (await page.title().catch(() => '')) || '';
      let nameHeading = pageTitle
        .replace(/^\(\d+\+?\)\s*/, '') // strip "(3) " unread-count prefix
        .replace(/\s*\|.*$/, '') // strip " | LinkedIn" suffix
        .trim();
      // Fallback: first non-empty <h1> ANYWHERE on the page (not just <main>).
      if (!nameHeading) {
        const h1s = (await page.locator('h1').allTextContents().catch(() => []))
          .map((t) => t.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        nameHeading = h1s[0] || '';
      }
      // No readable name ⇒ not a rendered profile (redirect / partial load / private
      // "LinkedIn Member"). ABORT — NEVER fall back to a page-wide Connect match,
      // which is what once invited rail people. Log the landed URL/title so a real
      // DOM change is diagnosable without a live probe.
      if (!nameHeading || /^linkedin( member)?$/i.test(nameHeading)) {
        const landedUrl = page.url();
        const redirected = !/\/in\//i.test(landedUrl);
        this.logger.warn(
          { requested: targetUrl, landedUrl, title: pageTitle, redirected, nameHeading },
          'Target name unreadable — aborting, no page-wide Connect fallback',
        );
        // A redirect OFF the profile is a real answer about this URL (auth wall,
        // gone) and stays terminal. An unreadable name on a profile URL is not —
        // it means we never got a usable page. Classifying that as
        // `no_connect_button` (TERMINAL, never retried) is how a slow link turned
        // live prospects into permanent failures; defer it instead.
        return redirected
          ? { status: 'no_connect_button', error: 'redirected_off_profile' }
          : { status: 'network_error', error: 'profile_not_loaded' };
      }

      // Precise, name-constrained matchers. LinkedIn labels each Connect control
      // "Invite <Full Name> to connect"; only the target's carries THIS name, so
      // matching by it can never resolve a rail person's control.
      const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameRe = escapeRe(nameHeading).replace(/\s+/g, '\\s+');
      const targetConnectRe = new RegExp(`^invite\\s+${nameRe}\\s+to connect$`, 'i');

      // Enumerate a container's buttons (text + aria-label) for diagnostics.
      const scanButtons = async (root: Locator, limit = 40) => {
        const bs = root.getByRole('button');
        const n = Math.min(await bs.count(), limit);
        const out: { text: string; label: string }[] = [];
        for (let i = 0; i < n; i++) {
          const b = bs.nth(i);
          const text = ((await b.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
          const label = ((await b.getAttribute('aria-label').catch(() => '')) || '').trim();
          if (text || label) out.push({ text, label });
        }
        return out;
      };

      // TOP CARD, anchored on the node that renders the target's NAME TEXT (not
      // assuming an <h1>) — the nearest ancestor of that text which also holds a
      // primary action button. Rails are siblings, so this excludes them. Used to
      // scope the Message/Pending/More lookups. If it can't be found we still have
      // the name-constrained Connect matcher below, so we fall back to `main`.
      const nameNode = page.getByText(nameHeading, { exact: true }).first();
      const topCard = nameNode.locator(
        'xpath=ancestor::*[.//button[contains(@aria-label," to connect") or ' +
          'normalize-space(.)="Message" or normalize-space(.)="More" or normalize-space(.)="More actions"]][1]',
      );
      const card: Locator = (await topCard.count().catch(() => 0)) > 0 ? topCard : main;

      // Message button in the target's card ⇒ already connected.
      const hasMessageBtn = async () =>
        (await card.getByRole('button', { name: /^Message$/i }).count().catch(() => 0)) > 0;

      const scope: SelectorScope = { page, card };

      // Pending invite already out? (Pending button in the target's card.)
      if ((await card.getByRole('button', { name: /^Pending$/i }).count().catch(() => 0)) > 0) {
        return { status: 'pending' };
      }

      // Defence-in-depth backstop: a resolved control must name THIS person.
      const norm = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const namesTarget = async (loc: Locator): Promise<boolean> => {
        const lbl = (await loc.getAttribute('aria-label').catch(() => '')) || '';
        const who = lbl.match(/invite\s+(.+?)\s+to connect/i)?.[1] || '';
        if (!who) return true; // no name on the control to disprove
        const a = norm(who);
        const b = norm(nameHeading);
        return !!a && !!b && (a === b || b.includes(a) || a.includes(b));
      };

      // DIRECT Connect = the control whose aria-label names THIS target. It may be
      // a <button> OR an <a href="/preload/custom-invite/?vanityName=<slug>">
      // ANCHOR (role=link) — the profile top card renders Connect as an anchor,
      // while the "People also viewed" rails render <button>s. Searching buttons
      // ONLY was the bug: it missed the anchor top-card Connect and matched a rail
      // button instead. Match either role, name-constrained so only THIS target's
      // control resolves — never a rail person's.
      const directConnect = () =>
        page
          .getByRole('button', { name: targetConnectRe })
          .or(page.getByRole('link', { name: targetConnectRe }))
          .first();
      await directConnect()
        .waitFor({ state: 'visible', timeout: 8000 })
        .catch(() => undefined);

      let connect: Locator | null =
        (await directConnect().count().catch(() => 0)) > 0 ? directConnect() : null;

      // DIAGNOSTIC: when the name-scoped matcher misses, dump every connect-ish
      // button on the page with its EXACT text + aria-label, so we learn precisely
      // how THIS profile's own Connect is labelled (vs the rail buttons) — and can
      // match it with certainty instead of guessing. Read-only, no click.
      if (!connect) {
        const bs = page.getByRole('button', { name: /connect/i });
        const n = Math.min(await bs.count().catch(() => 0), 12);
        const dump: { text: string; label: string }[] = [];
        for (let i = 0; i < n; i++) {
          const b = bs.nth(i);
          dump.push({
            text: ((await b.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim(),
            label: ((await b.getAttribute('aria-label').catch(() => '')) || '').trim(),
          });
        }
        this.logger.log({ nameHeading, connectButtons: dump }, 'Connect-candidate buttons (diagnostic)');
      }
      // Track whether Connect lives inside the "More" dropdown: a dropdown item
      // is position-anchored, so a PAGE scroll or a force-click-by-coordinate
      // closes/misses it. Menu items need a scroll-free, event-based click.
      let viaMenu = false;

      if (!connect) {
        // Overflow menu path — Connect hidden behind "More"/"More actions".
        const more = await resolveFirst(scope, SELECTORS.moreButton, 'moreButton', this.logger);
        if (!more) {
          const topBtns = await scanButtons(card);
          this.logger.log({ topBtns }, 'No Connect/More on profile (connect-step)');
          return { status: (await hasMessageBtn()) ? 'already_connected' : 'no_connect_button' };
        }
        await more.scrollIntoViewIfNeeded();
        // Open the overflow and VERIFY it opened before scanning for the item.
        // A blind multi-strategy click here is the "menu flashed open then shut"
        // failure: the first click opens the dropdown, the escalation's second
        // click toggles it closed, and the item scan then finds nothing.
        let menuOpened = false;
        for (let attempt = 0; attempt < 2 && !menuOpened; attempt++) {
          if (attempt === 0) await more.click({ timeout: 6000 }).catch(() => undefined);
          else await more.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
          const dropdown = await resolveFirst(scope, SELECTORS.dropdownContent, 'dropdownContent', this.logger);
          menuOpened = dropdown
            ? await dropdown
                .waitFor({ state: 'visible', timeout: 3500 })
                .then(() => true)
                .catch(() => false)
            : false;
          // Anchor menu-item resolution to THIS open dropdown, never page-wide —
          // the rails' Connect anchors live outside it and must not be matchable.
          if (menuOpened && dropdown) scope.menu = dropdown.filter({ visible: true }).first();
          if (!menuOpened) await sleep(rnd(500, 1000));
        }
        await sleep(rnd(600, 1300));
        // Inside the dropdown the Connect item is a menuitem / button / anchor.
        connect = await resolveFirst(scope, SELECTORS.connectMenuItem, 'connectMenuItem', this.logger);
        if (!connect) {
          // Diagnostics: dump the top-card buttons AND the dropdown's actual
          // content (dropdown items are often anchors, which a button-scan misses).
          const topBtns = await scanButtons(card);
          const menuC = page
            .locator('[role="menu"], .artdeco-dropdown__content')
            .filter({ visible: true })
            .first();
          const menuText = (await menuC.count().catch(() => 0))
            ? ((await menuC.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 300)
            : '';
          this.logger.log({ topBtns, menuOpened, menuText }, 'Connect not found after More (connect-step)');
          // Close the dropdown and re-check the top card once — some layouts
          // only hydrate the direct Connect button late. Name-scoped so the
          // recheck can't grab a rail control either.
          await page.keyboard.press('Escape').catch(() => undefined);
          await sleep(rnd(500, 1000));
          connect = (await directConnect().count().catch(() => 0)) > 0 ? directConnect() : null;
          if (!connect) {
            if (await hasMessageBtn()) return { status: 'already_connected' };
            const followOnly =
              (await card.getByRole('button', { name: /^Follow$/i }).count().catch(() => 0)) > 0;
            return {
              status: 'no_connect_button',
              error: followOnly ? 'follow_only_profile' : undefined,
            };
          }
        } else {
          viaMenu = true;
        }
      }

      // Diagnostic: record EXACTLY what we resolved so a future misfire is
      // debuggable from logs alone (tag/role/label/visible-text of the target).
      try {
        const info = await connect.evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          label: el.getAttribute('aria-label'),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48),
        }));
        this.logger.log({ connectEl: info, viaMenu }, 'Resolved Connect control');
      } catch {
        /* diagnostics only */
      }

      // 🔴 FINAL TARGET-IDENTITY GUARD (covers the menu path too). Whatever we
      // resolved — direct or via the More menu — must name THIS profile's person.
      // A mismatch means a rail/related control slipped through: abort, no click.
      // This is the hard backstop for the "one job → several wrong invites" bug.
      if (!(await namesTarget(connect))) {
        this.logger.warn(
          { profileName: nameHeading, viaMenu },
          'Resolved Connect control names a DIFFERENT person than the profile — aborting invite',
        );
        return { status: 'no_connect_button', error: 'connect_target_mismatch' };
      }

      // What "the invite opened" looks like — REAL signals only: the send-invite
      // modal, any dialog, or a specific weekly-limit line. (Earlier this also
      // matched loose text like "verify … member" / "enter … email", which
      // false-matched ordinary profile text — the automation then "confirmed" a
      // modal that never opened, scanned the page for a Send button, and mis-
      // clicked. Only trust structural dialog signals here.)
      const invitedTarget = page
        .locator('[data-test-modal-id="send-invite-modal"]')
        .or(page.getByRole('dialog'))
        .or(page.getByText(/reached the weekly|invitation limit/i));
      const invitedUi = () =>
        invitedTarget
          .filter({ visible: true })
          .first()
          .waitFor({ state: 'visible', timeout: 4000 })
          .then(() => true)
          .catch(() => false);

      // THE menu-Connect fix. The dropdown "Connect" is an <a> whose href is the
      // invite deep-link: "/preload/custom-invite/?vanityName=<slug>". Clicking it
      // relies on LinkedIn's SPA router intercepting the anchor — which is flaky
      // under automation (it either does a FULL navigation that reloads the page
      // before the composer renders — the "clicked, page just refreshed, no
      // modal" symptom — or the router click doesn't fire at all). Navigating
      // straight to that href deterministically renders the invite composer
      // (verified: send-invite-modal + "Add a note" both appear). So when Connect
      // is an anchor with that href, GOTO it instead of clicking.
      // The Connect control — whether the top-card DIRECT anchor or the "More"
      // menu item — is an <a href="/preload/custom-invite/?vanityName=<slug>">.
      // Clicking it relies on LinkedIn's SPA router intercepting the anchor, which
      // is flaky under automation (full navigation that reloads before the
      // composer renders, or the router click never firing). Navigating straight
      // to that href deterministically renders the invite composer. So for ANY
      // custom-invite anchor (direct or menu), GOTO it — after confirming its
      // vanityName is THIS target, never a rail person's.
      let opened = false;
      {
        const href = await connect!
          .evaluate((el) => (el.tagName === 'A' ? (el as HTMLAnchorElement).getAttribute('href') : null))
          .catch(() => null);
        const vanity = href ? (href.match(/vanityName=([^&]+)/i)?.[1] || '').toLowerCase() : '';
        const slugMatches = !!targetSlug && (!vanity || vanity === targetSlug);
        if (href && /custom-invite/.test(href) && slugMatches) {
          const abs = href.startsWith('http') ? href : 'https://www.linkedin.com' + href;
          this.logger.log({ abs, viaMenu }, 'Opening invite composer via Connect deep-link');
          await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
          await sleep(rnd(1500, 2600));
          if (await this.isCheckpoint(page)) return { status: 'checkpoint' };
          // The composer usually renders straight from the deep-link; if so, skip
          // the click strategies entirely.
          opened = await invitedUi();
        } else if (href && vanity && targetSlug && vanity !== targetSlug) {
          // Anchor points at a DIFFERENT person — do not send. Fail cleanly so the
          // job never invites a rail profile (root cause of past wrong invites).
          this.logger.warn({ vanity, targetSlug }, 'Connect resolved a non-target profile — aborting invite');
          return { status: 'no_connect_button', error: 'connect_target_mismatch' };
        }
      }

      // Click → verify → escalate. Each strategy is tried, then we check whether
      // the invite UI actually opened; we stop at the first one that works. This
      // beats "click once and hope", and beats re-trying the SAME strategy (a
      // plain click that silently no-ops would just no-op again).
      //  - Menu items: scroll-free, event-based (real click → dispatch → Enter).
      //  - Direct buttons: real click → centered click → DOM click → force click.
      const strategies: (() => Promise<unknown>)[] = viaMenu
        ? [
            async () => {
              await connect!.hover({ timeout: 3000 }).catch(() => undefined);
              return connect!.click({ timeout: 6000 });
            },
            () => connect!.dispatchEvent('click'),
            async () => {
              await connect!.focus().catch(() => undefined);
              return connect!.press('Enter');
            },
          ]
        : [
            async () => {
              await connect!.scrollIntoViewIfNeeded().catch(() => undefined);
              await connect!.hover().catch(() => undefined);
              return connect!.click({ timeout: 8000 });
            },
            () => connect!.evaluate((el) => (el as HTMLElement).click()),
            () => connect!.click({ force: true, timeout: 5000 }),
          ];

      for (let i = 0; i < strategies.length && !opened; i++) {
        try {
          await strategies[i]();
        } catch {
          /* try the next strategy */
        }
        await sleep(rnd(700, 1400));
        if (await this.isCheckpoint(page)) return { status: 'checkpoint' };
        if (await invitedUi()) opened = true;
        else if (i > 0) this.logger.warn({ strategy: i, viaMenu }, 'Connect click strategy did not open invite — escalating');
      }
      if (!opened) {
        this.logger.warn({ viaMenu }, 'Invite dialog never opened after all click strategies');
        return { status: 'failed', error: 'invite_dialog_never_opened' };
      }

      // Weekly-limit modal can appear right after clicking Connect.
      if (await page.locator('text=/reached the weekly|invitation limit/i').count()) {
        return { status: 'limit_reached' };
      }

      // The connect confirmation is the "send-invite-modal" (stable data-test id,
      // verified against the live DOM). Prefer it as the scope; fall back to any
      // role=dialog if LinkedIn renames it.
      const inviteModal = page.locator('[data-test-modal-id="send-invite-modal"]').first();
      const dialog = page.getByRole('dialog');
      const modal = (await inviteModal.count())
        ? inviteModal
        : (await dialog.count())
          ? dialog.last()
          : page.locator('body');

      // Extend the selector scope with the open modal so modal-anchored cascades
      // (add-note / note box / send button) resolve inside the dialog.
      const modalScope: SelectorScope = { page, card, modal };

      // Email-to-verify wall — detected by a REAL signal, not loose page text.
      // When a member restricts invites to "people who know my email", the invite
      // modal replaces the note composer with an EMAIL INPUT. Look for that input
      // INSIDE the modal only. (The old check scanned the whole page for phrases
      // like "verify … member" and false-matched ordinary profile text, wrongly
      // failing perfectly connectable leads with `email_required`.)
      const emailInput = modal
        .locator('input[type="email"], input[name*="email" i], input[id*="email" i]')
        .filter({ visible: true });
      if (await emailInput.count().catch(() => 0)) {
        this.logger.warn(
          "Invite modal shows an email-address field (member's invite privacy setting) — cannot invite this lead",
        );
        return { status: 'no_connect_button', error: 'email_required' };
      }

      // Personalize. Some accounts (and the premium note flow) open the modal with
      // the note textarea already present; others gate it behind an "Add a note"
      // button. Reveal it if needed, then type — but never hang: if no note field
      // appears (free-tier note cap / upsell), send without a note.
      if (message) {
        const addNote = await resolveFirst(modalScope, SELECTORS.addNote, 'addNote', this.logger);
        if (addNote) {
          await addNote.click().catch(() => undefined);
          await sleep(rnd(400, 900));
        }

        // Note-cap: free accounts get only a handful of PERSONALIZED-note invites
        // (per month). Once spent, the composer shows a limit banner — on free tier it
        // STILL renders a usable note field alongside it, and clicking Send with a
        // note is then rejected. Signal `note_cap` so the caller (connect-with-
        // fallback) can retry this lead WITHOUT a note — note-less requests keep
        // working up to the much larger weekly cap.
        //
        // CRITICAL: distinguish "notes AVAILABLE" from "note quota EXHAUSTED". While
        // notes REMAIN, LinkedIn shows "<N> personalized invitations remaining/left
        // this month" — that text contains "personalized invitation", so the old bare
        // `personalized invitation` alternative false-matched the POSITIVE banner and
        // sent every invite note-less even when notes were left (the reported "note not
        // deducted" bug). Fix: match ONLY genuine exhaustion phrases here, and read the
        // remaining-count separately below — a count > 0 is authoritative "available".
        const remainingBanner = modal
          .getByText(/personalized invit\w*\s+(remaining|left)/i)
          .filter({ visible: true })
          .first();
        const noteCapText = modal
          .getByText(
            /reached (the|your).{0,30}(personalized|note)|(0|no)\s+(free\s+)?personalized invit\w*|you.?ve used all|premium.{0,20}(note|personalize)|note.{0,15}is a premium|upgrade.{0,30}(add a note|personalize|send a note|note)/i,
          )
          .filter({ visible: true });
        const noteBox = (await resolveFirst(modalScope, SELECTORS.noteBox, 'noteBox', this.logger))
          ?? modal.locator('textarea, div[role="textbox"]').first();

        // Let the composer paint before reading the cap. The deep-link custom-invite
        // composer opens the note field directly (no "Add a note" click+sleep above),
        // so a single immediate count() could fire BEFORE the limit banner renders and
        // miss it — the intermittent "note count not detected" bug. Wait for either the
        // note field or the banner to be visible, then a brief settle to cover the case
        // where the note field paints a beat before the banner.
        await noteBox
          .first()
          .or(noteCapText.first())
          .waitFor({ state: 'visible', timeout: 4000 })
          .catch(() => undefined);
        await sleep(rnd(350, 650));

        // A visible "N ... remaining/left" count is the authoritative signal: N>0 means
        // notes ARE available, so never treat it as a cap (type the note). Only cap when
        // the count is explicitly 0, or there is no count but a true exhaustion phrase.
        let remaining: number | null = null;
        if (await remainingBanner.count().catch(() => 0)) {
          const bannerText = (await remainingBanner.innerText().catch(() => '')) || '';
          const m = bannerText.match(/(\d+)\s+(?:free\s+)?personalized invit\w*\s+(?:remaining|left)/i);
          if (m) remaining = parseInt(m[1], 10);
        }
        const capPhrase = await noteCapText.count().catch(() => 0);
        const capped = remaining === 0 || (remaining === null && !!capPhrase);
        if (capped) {
          this.logger.warn(
            { remaining },
            'Personalized-note quota exhausted (note-cap) — signalling fallback to a note-less connect',
          );
          return { status: 'limit_reached', error: 'note_cap' };
        }
        if (remaining !== null) {
          this.logger.log({ remaining }, `Personalized-note quota available (${remaining} left) — sending WITH a note`);
        }

        const noteReady = await noteBox.isVisible().catch(() => false);
        if (noteReady) {
          await noteBox.click().catch(() => undefined);
          for (const ch of message.slice(0, 300)) {
            await noteBox.type(ch, { delay: rnd(45, 165) }).catch(() => undefined);
            if (Math.random() < 0.06) await sleep(rnd(120, 400));
          }
          await think();
        }
      }

      // Send the invitation. Primary selector uses the exact accessible name from
      // the live DOM (aria-label="Send invitation"); then the modal action bar's
      // primary button; then a generic scan that eliminates cancel-type controls
      // and logs what it saw so the selector can be re-derived after a redesign.
      let sendClicked = false;
      const primarySend = await resolveFirst(modalScope, SELECTORS.sendInvite, 'sendInvite', this.logger);
      if (primarySend) {
        sendClicked = await this.robustClick(primarySend, 12000);
      }

      if (!sendClicked) {
        const buttons = modal.getByRole('button');
        const count = await buttons.count();
        const cancelish = /cancel|back|dismiss|close|got it|add a note|not now|write with ai/i;
        const info: { i: number; text: string; label: string; disabled: boolean }[] = [];
        for (let i = 0; i < count; i++) {
          const b = buttons.nth(i);
          const text = ((await b.innerText().catch(() => '')) || '').trim();
          const label = ((await b.getAttribute('aria-label').catch(() => '')) || '').trim();
          const disabled = await b.isDisabled().catch(() => false);
          info.push({ i, text, label, disabled });
        }
        this.logger.log({ buttons: info }, 'Connect modal buttons (send-step fallback)');

        const looksSend = (s: string) => /send/i.test(s) && !cancelish.test(s);
        let sendIdx = info.findIndex((b) => !b.disabled && (looksSend(b.text) || looksSend(b.label)));
        if (sendIdx < 0) {
          for (let i = info.length - 1; i >= 0; i--) {
            const b = info[i];
            if (!b.disabled && !cancelish.test(b.text) && !cancelish.test(b.label)) {
              sendIdx = i;
              break;
            }
          }
        }
        if (sendIdx < 0) return { status: 'failed', error: 'send_button_not_found' };
        await buttons.nth(sendIdx).click({ timeout: 12000 });
      }
      await sleep(rnd(1000, 2000));

      if (await this.isCheckpoint(page)) return { status: 'checkpoint' };

      // A weekly-limit / note-cap wall can surface right after clicking Send —
      // the click "succeeds" but nothing is sent. Catch it before confirming.
      if (await page.getByText(/reached the weekly|invitation limit|you.?ve reached/i).count().catch(() => 0)) {
        return { status: 'limit_reached' };
      }

      // ---- CONFIRM the invite actually went out (no false positives) ----
      // Clicking "Send" is NOT proof. A rejected send — most commonly the
      // free-tier PERSONALIZED-NOTE quota being exhausted — ALSO closes the
      // composer, so "the modal disappeared" is NOT a reliable sent signal (it
      // once marked leads sent whose profile still showed Connect). Trust only:
      //   (a) an "Invitation sent" toast, or (b) the control flipping to Pending;
      // otherwise verify on the profile itself.
      const sentToast = page
        .getByText(/invitation sent|invitation to .*(is|was) sent|sent your invitation|your invitation to .* was sent/i)
        .first();
      const pendingBtn = page.getByRole('button', { name: /^Pending$/i }).first();

      let confirmed = false;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !confirmed) {
        if (await sentToast.isVisible().catch(() => false)) confirmed = true;
        else if (await pendingBtn.isVisible().catch(() => false)) confirmed = true;
        else await sleep(400);
      }

      // Note-cap surfaced BY the send attempt (deep-link composer shows it only
      // after Send). Retry this lead WITHOUT a note — connect-with-fallback does
      // the note-less send, which works up to the much larger weekly cap.
      if (!confirmed && message) {
        const capNow = await page
          .getByText(
            /reached (the|your).{0,30}(personalized|note)|you.?ve used all|no free personalized|premium.{0,20}(note|personalize)|upgrade.{0,30}(note|personalize|send a note)/i,
          )
          .filter({ visible: true })
          .count()
          .catch(() => 0);
        if (capNow) {
          this.logger.warn('Note quota exhausted at send — falling back to a note-less connect');
          return { status: 'limit_reached', error: 'note_cap' };
        }
      }

      // Still unconfirmed → the composer may have closed with no toast/Pending.
      // GROUND TRUTH: reload the profile and check whether the target's OWN
      // Connect control is gone (or shows Pending). Only trust "Connect gone"
      // when the profile actually rendered (title carries the name), so a failed
      // page load can't masquerade as a successful send.
      if (!confirmed) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
        await sleep(rnd(1800, 3000));
        if (await this.isCheckpoint(page)) return { status: 'checkpoint' };
        const pendingNow = await page
          .getByRole('button', { name: /^Pending$/i })
          .first()
          .isVisible()
          .catch(() => false);
        const titleName = ((await page.title().catch(() => '')) || '').toLowerCase();
        const firstName = nameHeading.toLowerCase().split(/\s+/)[0] || '';
        const profileLoaded = !!firstName && titleName.includes(firstName);
        const connectStill = await directConnect().count().catch(() => 0);
        if (pendingNow || (profileLoaded && connectStill === 0)) {
          confirmed = true;
        } else {
          this.logger.warn(
            { pendingNow, profileLoaded, connectStill },
            'Invite NOT confirmed — profile still shows Connect (or did not load)',
          );
          // A note was typed → most likely the note quota; retry note-less.
          if (message) return { status: 'limit_reached', error: 'note_cap' };
          return { status: 'failed', error: 'invite_not_confirmed' };
        }
      }

      // The fast confirm path (toast / Pending flip) never navigates back to an
      // /in/<slug> URL — the page is still on the custom-invite deep-link, so
      // fall back to its vanityName param rather than losing the slug.
      const landedSlug = resolvedSlugFrom(page.url());
      const externalId = 'li_inv_' + Date.now().toString(36);
      return {
        status: 'sent',
        externalId,
        ...(landedSlug ? { resolvedSlug: landedSlug } : {}),
      };
    } catch (err: any) {
      return { status: 'failed', error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async sendMessage(
    targetUrl: string,
    message: string,
    ctx?: LinkedInActionContext,
  ): Promise<LinkedInActionResult> {
    targetUrl = this.normalizeProfileUrl(targetUrl);
    if (!ctx?.li_at) return { status: 'failed', error: 'NO_SESSION: account not logged in' };

    let context: BrowserContext | undefined;
    try {
      context = await this.openAccountContext({
        accountId: ctx.accountId,
        proxy: ctx.proxy,
        fingerprint: ctx.fingerprint,
        li_at: ctx.li_at,
        cookies: ctx.cookies,
      });
      const page = context.pages()[0] || (await context.newPage());

      const nav = await gotoProfile(page, targetUrl, (reason) =>
        this.logger.warn({ targetUrl, reason }, 'Profile navigation failed — retrying once'),
      );
      // Failing HERE is before anything is typed or clicked, so the message
      // provably did not go out and re-driving it cannot double-send.
      if (nav.error) return { status: 'network_error', error: `nav_failed: ${nav.error}` };
      const resp = nav.resp;
      await think();
      if (resp && resp.status() === 404) return { status: 'profile_gone' };
      if (await this.isCheckpoint(page)) return { status: 'checkpoint' };

      const scope: SelectorScope = { page };
      const msgBtn = await resolveFirst(scope, SELECTORS.messageButton, 'messageButton', this.logger);
      if (!msgBtn) return { status: 'no_connect_button' }; // not connected → can't message
      await msgBtn.click();
      await sleep(rnd(800, 1600));

      await typeLikeHuman(page, 'div[role="textbox"], .msg-form__contenteditable', message);
      await think();
      const send = await resolveFirst(scope, SELECTORS.messageSend, 'messageSend', this.logger);
      if (!send) return { status: 'failed', error: 'message_send_not_found' };
      await send.click();
      await sleep(rnd(800, 1600));

      const externalId = 'li_msg_' + Date.now().toString(36);
      return { status: 'sent', externalId };
    } catch (err: any) {
      return { status: 'failed', error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /** Open a profile page under the account session; returns the page + context
   *  so callers can act, or a classified failure. Caller MUST close the context. */
  private async openProfile(
    targetUrl: string,
    ctx?: LinkedInActionContext,
  ): Promise<
    | { ok: true; context: BrowserContext; page: Page }
    | { ok: false; context?: BrowserContext; result: LinkedInActionResult }
  > {
    targetUrl = this.normalizeProfileUrl(targetUrl);
    if (!ctx?.li_at) {
      return { ok: false, result: { status: 'failed', error: 'NO_SESSION: account not logged in' } };
    }
    const context = await this.openAccountContext({
      accountId: ctx.accountId,
      proxy: ctx.proxy,
      fingerprint: ctx.fingerprint,
      li_at: ctx.li_at,
      cookies: ctx.cookies,
    });
    const page = context.pages()[0] || (await context.newPage());
    const nav = await gotoProfile(page, targetUrl, (reason) =>
      this.logger.warn({ targetUrl, reason }, 'Profile navigation failed — retrying once'),
    );
    if (nav.error) {
      return { ok: false, context, result: { status: 'network_error', error: `nav_failed: ${nav.error}` } };
    }
    const resp = nav.resp;
    await think();
    if (resp && resp.status() === 404) return { ok: false, context, result: { status: 'profile_gone' } };
    if (await this.isCheckpoint(page)) return { ok: false, context, result: { status: 'checkpoint' } };
    return { ok: true, context, page };
  }

  /** Profile view — just landing on the page registers a view LinkedIn shows the lead. */
  async visitProfile(targetUrl: string, ctx?: LinkedInActionContext): Promise<LinkedInActionResult> {
    let context: BrowserContext | undefined;
    try {
      const opened = await this.openProfile(targetUrl, ctx);
      context = opened.context;
      if (!opened.ok) return opened.result;
      await humanScroll(opened.page);
      await think();
      return { status: 'sent', externalId: 'li_view_' + Date.now().toString(36) };
    } catch (err: any) {
      return { status: 'failed', error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /** Follow without connecting (direct Follow button, or via the More menu). */
  async follow(targetUrl: string, ctx?: LinkedInActionContext): Promise<LinkedInActionResult> {
    let context: BrowserContext | undefined;
    try {
      const opened = await this.openProfile(targetUrl, ctx);
      context = opened.context;
      if (!opened.ok) return opened.result;
      const page = opened.page;
      await humanScroll(page);

      if (await page.getByRole('button', { name: /^Following$/ }).count()) {
        return { status: 'already_connected' }; // already following — advance, no-op
      }
      let follow = page.getByRole('button', { name: /^Follow$/ }).first();
      if (!(await follow.count())) {
        const more = page.getByRole('button', { name: /^More/ }).first();
        if (!(await more.count())) return { status: 'no_connect_button' };
        await more.click();
        await sleep(rnd(500, 1200));
        follow = page.getByRole('menuitem', { name: /^Follow$/ }).first();
        if (!(await follow.count())) return { status: 'no_connect_button' };
      }
      await follow.scrollIntoViewIfNeeded();
      await page.mouse.move(rnd(200, 800), rnd(200, 500));
      await follow.click();
      await sleep(rnd(800, 1600));
      if (await this.isCheckpoint(page)) return { status: 'checkpoint' };
      return { status: 'sent', externalId: 'li_follow_' + Date.now().toString(36) };
    } catch (err: any) {
      return { status: 'failed', error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /** InMail — works on Open Profiles or when the account has InMail credits. */
  async sendInMail(
    targetUrl: string,
    subject: string,
    message: string,
    ctx?: LinkedInActionContext,
  ): Promise<LinkedInActionResult> {
    let context: BrowserContext | undefined;
    try {
      const opened = await this.openProfile(targetUrl, ctx);
      context = opened.context;
      if (!opened.ok) return opened.result;
      const page = opened.page;
      await humanScroll(page);

      // "Message" on a non-connection opens the InMail composer (Open Profile),
      // otherwise the primary CTA may be "Message" via the More menu.
      let msgBtn = page.getByRole('button', { name: /^Message$/ }).first();
      if (!(await msgBtn.count())) {
        const more = page.getByRole('button', { name: /^More/ }).first();
        if (await more.count()) {
          await more.click();
          await sleep(rnd(500, 1200));
          msgBtn = page.getByRole('menuitem', { name: /Message/ }).first();
        }
      }
      if (!(await msgBtn.count())) return { status: 'no_connect_button' };
      await msgBtn.click();
      await sleep(rnd(900, 1700));

      // InMail composer exposes a Subject field; a regular DM does not.
      const subjectField = page.locator('input[name="subject"], input[aria-label*="Subject" i]').filter({ visible: true }).first();
      if (subject && (await subjectField.count())) {
        await subjectField.click();
        await subjectField.fill(subject.slice(0, 200));
        await sleep(rnd(300, 700));
      }
      await typeLikeHuman(page, 'div[role="textbox"], .msg-form__contenteditable, textarea[name="message"]', message);
      await think();

      // Some InMail modals require accepting a "This will use a credit" confirm.
      const send = page.getByRole('button', { name: /^(Send|Send InMail)$/ }).first();
      if (!(await send.count())) return { status: 'failed', error: 'InMail composer not available (no credits / not open profile)' };
      await send.click();
      await sleep(rnd(1000, 2000));
      if (await this.isCheckpoint(page)) return { status: 'checkpoint' };
      return { status: 'sent', externalId: 'li_inmail_' + Date.now().toString(36) };
    } catch (err: any) {
      return { status: 'failed', error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /** Like the lead's most recent post (opens their activity feed). */
  async likeRecentPost(targetUrl: string, ctx?: LinkedInActionContext): Promise<LinkedInActionResult> {
    let context: BrowserContext | undefined;
    try {
      const activityUrl = this.normalizeProfileUrl(targetUrl).replace(/\/+$/, '') + '/recent-activity/all/';
      const opened = await this.openProfile(activityUrl, ctx);
      context = opened.context;
      if (!opened.ok) return opened.result;
      const page = opened.page;
      await humanScroll(page);

      // First un-pressed Like button in the activity list.
      const like = page
        .locator('button[aria-label*="Like" i][aria-pressed="false"], button:has-text("Like")')
        .filter({ visible: true })
        .first();
      if (!(await like.count())) return { status: 'no_connect_button' }; // no posts to like
      await like.scrollIntoViewIfNeeded();
      await page.mouse.move(rnd(200, 800), rnd(200, 500));
      await like.click();
      await sleep(rnd(800, 1500));
      if (await this.isCheckpoint(page)) return { status: 'checkpoint' };
      return { status: 'sent', externalId: 'li_like_' + Date.now().toString(36) };
    } catch (err: any) {
      return { status: 'failed', error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /** Endorse the lead's top skill. */
  async endorseSkill(targetUrl: string, ctx?: LinkedInActionContext): Promise<LinkedInActionResult> {
    let context: BrowserContext | undefined;
    try {
      const skillsUrl = this.normalizeProfileUrl(targetUrl).replace(/\/+$/, '') + '/details/skills/';
      const opened = await this.openProfile(skillsUrl, ctx);
      context = opened.context;
      if (!opened.ok) return opened.result;
      const page = opened.page;
      await humanScroll(page);

      const endorse = page
        .locator('button[aria-label*="Endorse" i]')
        .filter({ visible: true })
        .first();
      if (!(await endorse.count())) return { status: 'no_connect_button' };
      await endorse.scrollIntoViewIfNeeded();
      await endorse.click();
      await sleep(rnd(800, 1500));
      if (await this.isCheckpoint(page)) return { status: 'checkpoint' };
      return { status: 'sent', externalId: 'li_endorse_' + Date.now().toString(36) };
    } catch (err: any) {
      return { status: 'failed', error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /**
   * Read the account's recent connections + unread messages to detect accepted
   * invites and inbound replies. Read-only. Selectors here are LinkedIn-volatile
   * and follow the same "verify working" process as the login selectors.
   */
  async syncAccount(ctx?: LinkedInActionContext): Promise<LinkedInSyncResult> {
    if (!ctx?.li_at) return { accepted: [], replies: [], error: 'NO_SESSION' };
    let context: BrowserContext | undefined;
    const accepted: LinkedInSyncResult['accepted'] = [];
    const replies: LinkedInSyncResult['replies'] = [];
    try {
      context = await this.openAccountContext({
        accountId: ctx.accountId,
        proxy: ctx.proxy,
        fingerprint: ctx.fingerprint,
        li_at: ctx.li_at,
        cookies: ctx.cookies,
      });
      const page = context.pages()[0] || (await context.newPage());

      // --- Accepted invites: recently-added connections ---
      await page.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await think();
      if (await this.isCheckpoint(page)) return { checkpoint: true, accepted, replies };
      await humanScroll(page);
      const connLinks = await page
        .locator('a[href*="/in/"]')
        .evaluateAll((els) =>
          Array.from(new Set(els.map((e) => (e as HTMLAnchorElement).href).filter((h) => /\/in\//.test(h)))).slice(0, 40),
        )
        .catch(() => [] as string[]);
      for (const href of connLinks) accepted.push({ profileUrl: href.split('?')[0] });

      // --- Inbound replies: unread conversations ---
      await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await think();
      if (await this.isCheckpoint(page)) return { checkpoint: true, accepted, replies };

      const unread = page.locator('.msg-conversation-listitem--unread, li:has(.notification-badge--show)').filter({ visible: true });
      const unreadCount = Math.min(await unread.count().catch(() => 0), 15);
      for (let i = 0; i < unreadCount; i++) {
        try {
          const item = unread.nth(i);
          await item.click();
          await sleep(rnd(900, 1600));
          // Last inbound bubble text.
          const bubbles = page.locator('.msg-s-event-listitem .msg-s-event-listitem__body');
          const n = await bubbles.count().catch(() => 0);
          if (n === 0) continue;
          const text = (await bubbles.nth(n - 1).innerText().catch(() => '')).trim();
          if (!text) continue;
          // Resolve the participant profile link when present.
          const link = await page
            .locator('a.msg-thread__link-to-profile, a[href*="/in/"]')
            .first()
            .getAttribute('href')
            .catch(() => null);
          replies.push({
            text: text.slice(0, 2000),
            profileUrl: link ? link.split('?')[0] : undefined,
            externalId: 'li_reply_' + Buffer.from(text.slice(0, 40)).toString('hex').slice(0, 16),
          });
        } catch {
          /* skip this thread */
        }
      }

      return { accepted, replies };
    } catch (err: any) {
      return { accepted, replies, error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /** Withdraw sent invitations older than `olderThanDays`. */
  async withdrawStaleInvites(
    olderThanDays: number,
    ctx?: LinkedInActionContext,
  ): Promise<{ withdrawn: number; checkpoint?: boolean; error?: string }> {
    if (!ctx?.li_at) return { withdrawn: 0, error: 'NO_SESSION' };
    let context: BrowserContext | undefined;
    let withdrawn = 0;
    try {
      context = await this.openAccountContext({
        accountId: ctx.accountId,
        proxy: ctx.proxy,
        fingerprint: ctx.fingerprint,
        li_at: ctx.li_at,
        cookies: ctx.cookies,
      });
      const page = context.pages()[0] || (await context.newPage());
      await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/sent/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await think();
      if (await this.isCheckpoint(page)) return { withdrawn, checkpoint: true };
      await humanScroll(page);

      const cards = page.locator('li.invitation-card, [data-view-name="sent-invitation"]').filter({ visible: true });
      const total = Math.min(await cards.count().catch(() => 0), 50);
      for (let i = 0; i < total; i++) {
        try {
          const card = cards.nth(i);
          const ageText = (await card.innerText().catch(() => '')).toLowerCase();
          if (!this.inviteOlderThan(ageText, olderThanDays)) continue;
          const withdrawBtn = card.getByRole('button', { name: /Withdraw/i }).first();
          if (!(await withdrawBtn.count())) continue;
          await withdrawBtn.click();
          await sleep(rnd(500, 1100));
          // Confirm modal.
          const confirm = page.getByRole('button', { name: /^Withdraw$/ }).filter({ visible: true }).first();
          if (await confirm.count()) await confirm.click();
          await sleep(rnd(700, 1400));
          withdrawn++;
        } catch {
          /* skip */
        }
      }
      return { withdrawn };
    } catch (err: any) {
      return { withdrawn, error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /** Parse LinkedIn's "Sent N days/weeks/months ago" into an age gate. */
  private inviteOlderThan(text: string, days: number): boolean {
    const m = text.match(/sent\s+(\d+)\s+(day|week|month|year)/);
    if (!m) return /month|year/.test(text); // undated but clearly old
    const n = parseInt(m[1], 10);
    const unitDays = { day: 1, week: 7, month: 30, year: 365 }[m[2]] || 1;
    return n * unitDays >= days;
  }

  /* ---- login / cookie capture (runs once at connect) ---- */

  async login(ctx: LinkedInLoginContext): Promise<LinkedInLoginResult> {
    let context: BrowserContext | undefined;
    try {
      context = await this.openAccountContext({
        accountId: ctx.accountId,
        proxy: ctx.proxy,
        fingerprint: ctx.fingerprint,
      });
      const page = context.pages()[0] || (await context.newPage());

      // If the persistent profile is already signed in, reuse it — no
      // re-login (repeated logins are the #1 bot-detection trigger).
      const jar = (await context.cookies('https://www.linkedin.com')) as StoredCookie[];
      const existing = jar.find((c) => c.name === 'li_at');
      if (existing?.value) {
        return {
          status: 'connected',
          li_at: existing.value,
          cookies: jar,
          fingerprint: ctx.fingerprint,
        };
      }

      await page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await think();

      // Already authenticated (redirected to feed)? Capture and stop.
      if (/\/feed|\/checkpoint\/lg\/login-submit/.test(page.url())) {
        const j2 = (await context.cookies('https://www.linkedin.com')) as StoredCookie[];
        const c = j2.find((x) => x.name === 'li_at');
        if (c?.value) {
          return { status: 'connected', li_at: c.value, cookies: j2, fingerprint: ctx.fingerprint };
        }
      }

      // LinkedIn serves several login layouts — try robust selectors.
      const USERNAME_SEL =
        '#username, input[autocomplete="username"], input[name="session_key"], input[type="email"]';
      const PASSWORD_SEL =
        '#password, input[autocomplete="current-password"], input[name="session_password"], input[type="password"]';

      // A profile LinkedIn RECOGNISES gets the "Welcome back" page: the account's
      // name, a masked email, and a password field only — no username input. We
      // use persistent profiles deliberately, so that page is the norm for a
      // re-login, yet the old code always typed the email first and waited 15s on
      // a selector that would never appear, threw, and closed the browser. Every
      // re-login through an established profile died there.
      const visible = (sel: string) =>
        page.locator(sel).filter({ visible: true }).count().catch(() => 0);
      let variant = classifyLoginForm({
        hasUsernameField: (await visible(USERNAME_SEL)) > 0,
        hasPasswordField: (await visible(PASSWORD_SEL)) > 0,
      });

      if (variant === 'remembered') {
        // Whose account does this profile remember? A mismatch must NOT get this
        // account's password: that is a failed login attempt against someone
        // else's identity. Fall back to the full form via "another account".
        const masked = (
          (await page
            .locator('text=/\\S+@\\S+/')
            .first()
            .innerText()
            .catch(() => '')) || ''
        ).trim();
        if (!rememberedAccountMatches(masked, ctx.email)) {
          this.logger.warn(
            { accountId: ctx.accountId },
            'Profile remembers a different account — switching to the full sign-in form',
          );
          await page
            .getByRole('button', { name: /sign in using another account/i })
            .or(page.getByRole('link', { name: /sign in using another account/i }))
            .first()
            .click({ timeout: 8000 })
            .catch(() => undefined);
          await sleep(rnd(1200, 2200));
          variant = (await visible(USERNAME_SEL)) > 0 ? 'full' : 'unknown';
        }
      }

      if (variant === 'unknown') {
        return { status: 'checkpoint', error: 'unrecognised_login_page' };
      }

      if (variant === 'full') {
        await typeLikeHuman(page, USERNAME_SEL, ctx.email);
        await sleep(rnd(400, 900));
      }
      // Both layouts end the same way: password, then Sign in.
      await typeLikeHuman(page, PASSWORD_SEL, ctx.password);
      await think();
      await page.getByRole('button', { name: /^Sign in$/ }).first().click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await sleep(rnd(2000, 4000));

      // 2FA challenge — generate the PIN from the stored seed and submit it.
      const pinSel =
        'input[name="pin"], #input__phone_verification_pin, input[autocomplete="one-time-code"]';
      const needs2fa =
        /checkpoint\/challenge|two-step|verification/i.test(page.url()) ||
        (await page.locator(pinSel).count()) > 0;
      if (needs2fa) {
        if (!ctx.totpSecret) return { status: 'checkpoint', error: '2FA required but no TOTP seed stored' };

        // WHICH code is LinkedIn asking for? A stored seed can only answer the
        // authenticator challenge. Typing that code into an email/SMS challenge
        // submits a WRONG pin — a failed login attempt, which is exactly the
        // signal that gets an account challenged harder. Stop instead of
        // guessing, and say which factor is needed so the UI can explain it.
        const challengeText = (await page.locator('body').innerText().catch(() => '')) || '';
        const challenge = classifyPinChallenge(challengeText);
        if (challenge !== 'totp') {
          this.logger.warn(
            { accountId: ctx.accountId, challenge },
            'LinkedIn asked for a code we cannot generate — not guessing with the TOTP seed',
          );
          return {
            status: 'checkpoint',
            error:
              challenge === 'unknown'
                ? 'unrecognised_pin_challenge'
                : `${challenge}_pin_required`,
          };
        }
        // Pick the VISIBLE input/button (LinkedIn ships hidden duplicates).
        const pinInput = page.locator(pinSel).filter({ visible: true }).first();
        // The PIN field may never actually appear: LinkedIn can auto-trust this
        // persistent profile and redirect straight to the feed. Don't hard-fail
        // on the wait — only enter the PIN if the field truly shows; otherwise
        // fall through to the li_at capture below (a /feed/ redirect means we're
        // already signed in). Previously this waitFor threw on timeout and a
        // SUCCESSFUL login was misreported as "failed".
        const pinVisible = await pinInput
          .waitFor({ state: 'visible', timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        if (pinVisible) {
          const pin = authenticator.generate(ctx.totpSecret);
          await pinInput.fill(pin);
          await think();
          const submit = page
            .locator('#two-step-submit-button, button[type="submit"], button:has-text("Submit")')
            .filter({ visible: true })
            .first();
          await submit.click().catch(() => undefined);
          await page.waitForLoadState('domcontentloaded').catch(() => undefined);
          await sleep(rnd(2000, 4000));
        }
      }

      // Any residual security wall → surface as checkpoint (needs human).
      if (await this.isCheckpoint(page)) {
        return { status: 'checkpoint', error: 'Security checkpoint during login' };
      }

      // Capture the WHOLE jar. `li_at` names the session, but it cannot hold one
      // on its own: replayed alone into a fresh profile it redirect-loops, because
      // LinkedIn also needs JSESSIONID / bcookie / bscookie / liap alongside it.
      const cookies = (await context.cookies('https://www.linkedin.com')) as StoredCookie[];
      const liAt = cookies.find((c) => c.name === 'li_at');
      if (!liAt?.value) {
        return { status: 'failed', error: 'Login did not yield a session cookie (bad credentials?)' };
      }

      return {
        status: 'connected',
        li_at: liAt.value,
        cookies,
        fingerprint: ctx.fingerprint,
      };
    } catch (err: any) {
      return { status: 'failed', error: String(err?.message || err) };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }
}
