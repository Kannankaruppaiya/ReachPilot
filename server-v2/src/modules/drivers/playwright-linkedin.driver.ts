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
  isSignedOutNav,
  isProfileGoneNav,
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
/** The `vanityName` of a custom-invite deep-link, verbatim; same shape as `slugOf`. */
export const vanityNameOf = (u: string): string => u.match(/[?&]vanityName=([^&]+)/i)?.[1] || '';
/**
 * The slug a confirmed invite resolved to: `/in/<slug>` if the page is on a
 * profile, else the deep-link's `vanityName`. Exported so the fallback is
 * testable (test/resolved-slug-fallback.spec.ts). Never navigates.
 */
export const resolvedSlugFrom = (url: string): string => slugOf(url) || vanityNameOf(url);
/**
 * True for LinkedIn's obfuscated member-URN slug ("ACwAAC551Qg…"). LinkedIn
 * canonicalises it to the vanity, so it can never serve as an identity guard.
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
 * Wait for the lazily loaded top-card buttons. Too short on a slow link reports a
 * false `no_connect_button`, which is terminal.
 */
const ACTION_BAR_TIMEOUT_MS = 30_000;

/** The bit of a navigation response {@link gotoProfile} reads. */
export interface NavResponse {
  status(): number;
}
/** The slice of a Playwright `Page` that {@link gotoProfile} uses; tests pass a plain object. */
export interface NavigablePage {
  goto(url: string, opts: { waitUntil: 'commit'; timeout: number }): Promise<NavResponse | null>;
  url(): string;
  waitForLoadState(state: 'domcontentloaded', opts: { timeout: number }): Promise<void>;
  locator(selector: string): {
    first(): { waitFor(opts: { state: 'attached'; timeout: number }): Promise<void> };
  };
}

/**
 * This target's Connect control. Role lookup alone misses it (the invite is
 * often an <a role="menuitem"> with the label on an inner <div>), so also match
 * the invite anchor by its `vanityName` href, which keeps it target-scoped.
 * Returns the union; callers pick.
 */
export function connectControl(
  page: Page,
  { nameHeading, targetSlug }: { nameHeading: string; targetSlug: string },
): Locator {
  const nameRe = new RegExp(
    `^invite\\s+${nameHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\s+to connect$`,
    'i',
  );
  // Tier 1: a real <button>, or an <a> with its implicit link role; name-constrained.
  let loc = page.getByRole('button', { name: nameRe }).or(page.getByRole('link', { name: nameRe }));

  // Tier 2 — the invite anchor, identified by the slug in its own href.
  if (/^[a-z0-9._-]+$/i.test(targetSlug)) {
    loc = loc.or(page.locator(`a[href*="custom-invite"][href*="vanityName=${targetSlug}"]`));
  } else {
    // No usable slug: match the anchor that contains this target's label.
    const label = `Invite ${nameHeading} to connect`.replace(/"/g, '\\"');
    loc = loc.or(page.locator('a[href*="custom-invite"]').filter({ has: page.locator(`[aria-label="${label}"]`) }));
  }
  return loc;
}

/**
 * This target's "Pending" (invite outstanding) control. It is an <a> whose label
 * names the person, so match the aria-label, not a button role. LinkedIn replaces
 * Connect with Pending, so missing this misreports a sent invite as failed.
 */
export function pendingControl(page: Page, nameHeading: string): Locator {
  const name = nameHeading.replace(/["\\]/g, '\\$&');
  return page
    .locator(`[aria-label^="Pending" i][aria-label*="${name}" i]`)
    .or(page.getByRole('button', { name: /^Pending$/i }))
    .filter({ visible: true });
}

/**
 * The target's "Message" link (already connected). Rail suggestions render
 * labelled "Message <name>" links; only the target's is unlabelled.
 */
export function connectedControl(page: Page): Locator {
  return page
    .locator('a[href*="/messaging/compose"]:not([aria-label*="Message" i])')
    .or(page.getByRole('button', { name: /^Message$/i }))
    .filter({ visible: true });
}

/**
 * Does the page say there is no profile here? LinkedIn often answers a dead URL
 * with a 200 whose error text renders client-side later, so callers re-ask after
 * the page settles. Deliberately narrow: not checkpoints or sign-in walls.
 */
export async function profileUnavailable(page: {
  locator(sel: string): { count(): Promise<number> };
}): Promise<boolean> {
  const n = await page
    .locator(
      'text=/this profile is not available|profile.{0,20}not available|page doesn.?t exist|isn.?t available right now|no longer active|this page doesn.?t exist|page not found/i',
    )
    .count()
    .catch(() => 0);
  return n > 0;
}

/**
 * Navigate to a profile on a possibly slow link: commit the navigation, then wait
 * for a rendered body rather than document-complete. Use only for an action's
 * FIRST navigation; a failure here proves nothing was clicked, which is what
 * makes re-driving `network_error` safe.
 */
export async function gotoProfile(
  page: NavigablePage,
  url: string,
  onRetry?: (reason: string) => void,
): Promise<{ resp: NavResponse | null; error?: string; signedOut?: boolean }> {
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
      // A dead session fails the same way on every retry; stop instead of adding traffic.
      if (isSignedOutNav('', lastErr)) return { resp: null, error: lastErr, signedOut: true };
      continue;
    }
    // A 404 is a real answer: return it so the caller marks the profile gone.
    if (resp && resp.status() === 404) return { resp };
    // LinkedIn usually answers with a 200 redirect to /404/; normalise it to a 404.
    if (isProfileGoneNav(page.url())) return { resp: { status: () => 404 } };
    await page
      .waitForLoadState('domcontentloaded', { timeout: NAV_READY_TIMEOUT_MS })
      .catch(() => undefined);
    const rendered = await page
      .locator('main, h1')
      .first()
      .waitFor({ state: 'attached', timeout: NAV_READY_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    // The /404/ redirect can also happen client-side, after the commit.
    if (isProfileGoneNav(page.url())) return { resp: { status: () => 404 } };
    if (rendered) {
      if (isSignedOutNav(page.url(), '')) {
        return { resp, error: `signed_out: landed on ${page.url()}`, signedOut: true };
      }
      return { resp };
    }
    lastErr = 'body never rendered';
  }
  return { resp: null, error: lastErr || 'navigation_failed' };
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------------- driver ---------------- */

/**
 * Real LinkedIn automation. Each call opens an account-pinned browser context,
 * acts like a human, detects checkpoints, classifies the outcome and closes it.
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
   * Distributed per-account browser lock: Chromium can't open a profile another
   * process holds, and actions, sync and invite withdrawal all open the same one.
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
            // Compare-and-delete so we never release a lock another worker now owns.
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
   * Click with escalation: normal → centred → DOM .click() → force. Force clicks by
   * coordinate and can land on the wrong element, so it goes last. Returns whether
   * any strategy worked.
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

  /** Persistent profile dir per account, so LinkedIn recognises the device. */
  private profileDir(accountId?: string): string {
    const dir = path.join(os.tmpdir(), 'reachpilot-profiles', accountId || 'default');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Remove Chromium singleton locks left by a crashed run; otherwise every later
   * launch fails with "Opening in existing browser session". Safe because the
   * account lock guarantees no live session holds this profile.
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
   * Open the account's persistent context: real Chrome channel (fallback Chromium),
   * proxy with matching locale/timezone, and fingerprint patches.
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

    // One live browser per account; throws BROWSER_BUSY so the scheduler retries.
    const lock = await this.acquireBrowserLock(opts.accountId);

    const dir = this.profileDir(opts.accountId);
    // Self-heal after an unclean shutdown.
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

    // Release the account lock whenever the context closes.
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

    // Restore the stored session only into a profile that has none: the profile's
    // cookie is the newest LinkedIn issued, the vault's may be revoked.
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

      // Real Chrome exposes a PluginArray of five PDF plugins; a number array is a headless tell.
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

  /**
   * Normalise an imported profile URL to https://www.linkedin.com/in/…: adds a
   * missing scheme (page.goto rejects it) and saves redirect hops.
   */
  private normalizeProfileUrl(url: string): string {
    let u = (url || '').trim();
    if (!u) return u;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    u = u.replace(/^http:\/\//i, 'https://');
    // Country/locale hosts (in., uk., www.linkedin.cn …) all redirect to www.
    u = u.replace(/^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com/i, 'https://www.linkedin.com');
    return u;
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
        if (nav.signedOut) return { status: 'session_expired', error: nav.error };
        return { status: 'network_error', error: `nav_failed: ${nav.error}` };
      }
      const resp = nav.resp;
      await think();

      // The intended target's slug guards the custom-invite deep-link below: rails
      // carry their own invite anchors. An opaque member-URN slug can't match the
      // anchor's vanityName, so only a vanity slug is trusted, re-read after landing.
      const requestedSlug = slugOf(targetUrl);
      let targetSlug = isOpaqueSlug(requestedSlug) ? '' : requestedSlug.toLowerCase();

      if (resp && resp.status() === 404) return { status: 'profile_gone' };
      if (await this.isCheckpoint(page)) return { status: 'checkpoint' };

      // LinkedIn often serves a 200 page for deleted or restricted profiles.
      if (await profileUnavailable(page)) return { status: 'profile_gone', error: 'profile_not_found' };

      await humanScroll(page);

      const main = page.locator('main').first();

      // Wait for the lazily loaded action bar before scanning. A feed "Follow" button
      // in <main> can satisfy the wait early, so log what matched.
      const actionBarBtn = main
        .getByRole('button', { name: /^(Connect|Message|Follow|Following|More|More actions|Pending)$/i })
        .first();
      const barOk = await actionBarBtn
        .waitFor({ state: 'visible', timeout: ACTION_BAR_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      const barWho = barOk
        ? await actionBarBtn
            .evaluate((el) => ({
              text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
              label: el.getAttribute('aria-label') || '',
              inTopCard: !el.closest('[class*="feed"], article'),
            }))
            .catch(() => null)
        : null;
      this.logger.log({ barOk, barWho }, 'Action-bar wait settled');
      await sleep(rnd(500, 1200));

      // Arrived via an opaque URN: use the canonical vanity from the landed URL. If
      // there is none, skip the deep-link shortcut; `namesTarget()` still guards clicks.
      if (!targetSlug) {
        const landedSlug = slugOf(page.url());
        if (landedSlug && !isOpaqueSlug(landedSlug)) {
          targetSlug = landedSlug.toLowerCase();
          this.logger.log({ requestedSlug, targetSlug }, 'Resolved opaque profile URL to vanity slug');
        }
      }

      // Target name from the page title ("<Name> | LinkedIn"), more reliable than the
      // <h1>. It picks the target's Connect out of the rails' invite buttons.
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
      // No readable name: not a rendered profile. Abort; never fall back to a
      // page-wide Connect match (that invites rail people).
      if (!nameHeading || /^linkedin( member)?$/i.test(nameHeading)) {
        const landedUrl = page.url();
        const redirected = !/\/in\//i.test(landedUrl);
        this.logger.warn(
          { requested: targetUrl, landedUrl, title: pageTitle, redirected, nameHeading },
          'Target name unreadable — aborting, no page-wide Connect fallback',
        );
        // A redirect off the profile is a real answer (terminal). An unreadable name on
        // a profile URL means the page never loaded, so defer instead.
        if (redirected) return { status: 'no_connect_button', error: 'redirected_off_profile' };
        // A dead /in/<slug> looks like a slow page here and renders "doesn't exist" late,
        // so ask again; otherwise it is re-deferred every 10 minutes forever.
        if (await profileUnavailable(page)) return { status: 'profile_gone', error: 'profile_not_found' };
        return { status: 'network_error', error: 'profile_not_loaded' };
      }

      // Each Connect is labelled "Invite <Full Name> to connect"; matching the name excludes rails.
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

      // Top card = nearest ancestor of the name text that holds an action button
      // (rails are siblings). Falls back to <main>.
      const nameNode = page.getByText(nameHeading, { exact: true }).first();
      const topCard = nameNode.locator(
        'xpath=ancestor::*[.//button[contains(@aria-label," to connect") or ' +
          'normalize-space(.)="Message" or normalize-space(.)="More" or normalize-space(.)="More actions"]][1]',
      );
      const card: Locator = (await topCard.count().catch(() => 0)) > 0 ? topCard : main;

      // Message button in the target's card ⇒ already connected.
      const hasMessageBtn = async () => (await connectedControl(page).count().catch(() => 0)) > 0;

      const scope: SelectorScope = { page, card };

      // Check Pending before Connect: LinkedIn replaces Connect with Pending once an invite is out.
      if ((await pendingControl(page, nameHeading).count().catch(() => 0)) > 0) {
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

      // Direct Connect: a <button> or custom-invite <a> whose label names this target.
      const directConnect = () => connectControl(page, { nameHeading, targetSlug }).first();
      await directConnect()
        .waitFor({ state: 'visible', timeout: 8000 })
        .catch(() => undefined);

      let connect: Locator | null =
        (await directConnect().count().catch(() => 0)) > 0 ? directConnect() : null;

      // Diagnostic (read-only): log every connect-ish control when the matcher misses.
      if (!connect) {
        // Scan the DOM, not getByRole('button'): the top-card Connect is often an <a>.
        const dump = await page
          .evaluate(() => {
            const out: { tag: string; role: string; text: string; label: string; href: string; shown: boolean }[] = [];
            document
              .querySelectorAll('button, a, [role="button"], [role="menuitem"], [aria-label*="to connect" i]')
              .forEach((el) => {
                const label = el.getAttribute('aria-label') || '';
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!/connect/i.test(label) && !/^connect$/i.test(text)) return;
                const r = (el as HTMLElement).getBoundingClientRect();
                out.push({
                  tag: el.tagName.toLowerCase(),
                  role: el.getAttribute('role') || '',
                  text: text.slice(0, 30),
                  label,
                  href: (el.getAttribute('href') || '').slice(0, 60),
                  shown: r.width > 0 && r.height > 0,
                });
              });
            return out.slice(0, 12);
          })
          .catch(() => [] as { tag: string; role: string; text: string; label: string; href: string; shown: boolean }[]);
        this.logger.log(
          {
            nameHeading,
            targetConnectRe: String(targetConnectRe),
            candidates: dump.map((d) => ({ ...d, matches: targetConnectRe.test(d.label) })),
          },
          'Connect-candidate controls (diagnostic)',
        );
      }
      // Menu items are position-anchored: a page scroll or force click closes or misses
      // them, so they need a scroll-free, event-based click.
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
        // Verify the menu opened before scanning; a second escalation click would toggle
        // it shut again.
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
          // Resolve menu items inside this dropdown only, never page-wide.
          if (menuOpened && dropdown) scope.menu = dropdown.filter({ visible: true }).first();
          if (!menuOpened) await sleep(rnd(500, 1000));
        }
        await sleep(rnd(600, 1300));
        // Inside the dropdown the Connect item is a menuitem / button / anchor.
        connect = await resolveFirst(scope, SELECTORS.connectMenuItem, 'connectMenuItem', this.logger);
        if (!connect) {
          // Diagnostics: top-card buttons and the dropdown (items are often anchors).
          const topBtns = await scanButtons(card);
          const menuC = page
            .locator('[role="menu"], .artdeco-dropdown__content')
            .filter({ visible: true })
            .first();
          const menuText = (await menuC.count().catch(() => 0))
            ? ((await menuC.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 300)
            : '';
          this.logger.log({ topBtns, menuOpened, menuText }, 'Connect not found after More (connect-step)');
          // Close the dropdown and re-check the top card once; some layouts hydrate late.
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

      // Diagnostic: log exactly what was resolved.
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

      // 🔴 Final identity guard (menu path too): the control must name this person,
      // or a rail control slipped through. Abort without clicking.
      if (!(await namesTarget(connect))) {
        this.logger.warn(
          { profileName: nameHeading, viaMenu },
          'Resolved Connect control names a DIFFERENT person than the profile — aborting invite',
        );
        return { status: 'no_connect_button', error: 'connect_target_mismatch' };
      }

      // "Invite opened" = the send-invite modal, any dialog, or the weekly-limit line.
      // Structural signals only; loose text matches ordinary profile copy.
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

      // Connect is an <a href="/preload/custom-invite/?vanityName=<slug>">. Clicking it
      // relies on LinkedIn's SPA router, which is flaky under automation; navigating to
      // the href opens the composer reliably. Only after checking vanityName is this target.
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
          // The composer usually renders straight from the deep-link.
          opened = await invitedUi();
        } else if (href && vanity && targetSlug && vanity !== targetSlug) {
          // Anchor points at a different person: do not send.
          this.logger.warn({ vanity, targetSlug }, 'Connect resolved a non-target profile — aborting invite');
          return { status: 'no_connect_button', error: 'connect_target_mismatch' };
        }
      }

      // Click, check the invite UI opened, escalate to the next strategy if not.
      // Menu items: real click → dispatch → Enter. Buttons: real → centred → DOM → force.
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

      // Scope to the send-invite modal (stable data-test id), else any dialog.
      const inviteModal = page.locator('[data-test-modal-id="send-invite-modal"]').first();
      const dialog = page.getByRole('dialog');
      const modal = (await inviteModal.count())
        ? inviteModal
        : (await dialog.count())
          ? dialog.last()
          : page.locator('body');

      // Add the modal to the selector scope so modal cascades resolve inside it.
      const modalScope: SelectorScope = { page, card, modal };

      // Email-to-verify wall: the modal shows an email input instead of the note box.
      // Look only inside the modal.
      const emailInput = modal
        .locator('input[type="email"], input[name*="email" i], input[id*="email" i]')
        .filter({ visible: true });
      if (await emailInput.count().catch(() => 0)) {
        this.logger.warn(
          "Invite modal shows an email-address field (member's invite privacy setting) — cannot invite this lead",
        );
        return { status: 'no_connect_button', error: 'email_required' };
      }

      // Add the note, revealing it via "Add a note" if needed. If no note field appears
      // (note cap / upsell), send without one.
      if (message) {
        const addNote = await resolveFirst(modalScope, SELECTORS.addNote, 'addNote', this.logger);
        if (addNote) {
          await addNote.click().catch(() => undefined);
          await sleep(rnd(400, 900));
        }

        // Free accounts get a few personalised notes a month. When they run out, return
        // `note_cap` so connect-with-fallback retries without a note. Match only true
        // exhaustion phrases: "<N> personalized invitations remaining" is the positive
        // banner, and the count below is authoritative.
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

        // Wait for the note field or the limit banner to paint before reading the cap.
        await noteBox
          .first()
          .or(noteCapText.first())
          .waitFor({ state: 'visible', timeout: 4000 })
          .catch(() => undefined);
        await sleep(rnd(350, 650));

        // A visible "N remaining" count wins: N > 0 means notes are available. Cap only on
        // an explicit 0, or no count plus an exhaustion phrase.
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

      // Send: exact "Send invitation" label, then the modal's primary button, then a
      // logged generic scan that skips cancel-type controls.
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

      // A limit wall can appear right after Send, meaning nothing was sent.
      if (await page.getByText(/reached the weekly|invitation limit|you.?ve reached/i).count().catch(() => 0)) {
        return { status: 'limit_reached' };
      }

      // Confirm the invite went out. A rejected send also closes the composer, so trust
      // only an "Invitation sent" toast or a Pending flip; otherwise check the profile.
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

      // Note cap shown only after Send: retry this lead without a note.
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

      // Still unconfirmed: reload the profile and check the target's Connect is gone or
      // Pending. Only trust that if the profile rendered (title has the name).
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

      // The fast confirm path stays on the deep-link, so fall back to its vanityName.
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
      // Nothing typed or clicked yet, so re-driving can't double-send.
      if (nav.signedOut) return { status: 'session_expired', error: nav.error };
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

  /** Open a profile under the account session. Caller MUST close the context. */
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
      if (nav.signedOut) {
        return { ok: false, context, result: { status: 'session_expired', error: nav.error } };
      }
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

      // On a non-connection, "Message" opens the InMail composer (Open Profile).
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
   * Read recent connections and unread messages to detect acceptances and replies.
   * Read-only; selectors are LinkedIn-volatile.
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

      // Reuse a signed-in profile; repeated logins are the top detection trigger.
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

      // A recognised profile gets the "Welcome back" page: password only, no email
      // field. Persistent profiles make that the normal re-login layout.
      const visible = (sel: string) =>
        page.locator(sel).filter({ visible: true }).count().catch(() => 0);
      let variant = classifyLoginForm({
        hasUsernameField: (await visible(USERNAME_SEL)) > 0,
        hasPasswordField: (await visible(PASSWORD_SEL)) > 0,
      });

      if (variant === 'remembered') {
        // Check which account the profile remembers; never type this account's password
        // into someone else's. On a mismatch, use "another account".
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

        // A stored TOTP seed only answers the authenticator challenge; a wrong PIN on an
        // email/SMS challenge is a failed login. Stop and report the needed factor.
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
        // LinkedIn may trust the profile and skip the PIN, so don't fail if the field
        // never shows; a /feed/ redirect means we're signed in.
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

      // Capture the whole jar: li_at alone redirect-loops without JSESSIONID, bcookie,
      // bscookie and liap.
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
