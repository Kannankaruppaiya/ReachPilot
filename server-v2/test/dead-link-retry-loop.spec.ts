/**
 * Regression: a dead (404) profile link was re-run as a job forever.
 *
 * OBSERVED: a lead URL LinkedIn no longer serves a profile for renders as a
 * plain "LinkedIn"-titled page — no name, no action bar — while STAYING on its
 * own /in/<slug> URL. The driver read that as "we never got a usable page"
 * (`network_error` / `profile_not_loaded`), the worker deferred it (+10 min),
 * the scheduler re-queued it, and the desktop agent opened the same dead link
 * again. Nothing in that circle ever ended it: the same link was re-run every
 * ten minutes, day and night, burning a queue slot and a browser tab.
 *
 * Two defects, both covered here:
 *   1. CLASSIFICATION — LinkedIn's "this page doesn't exist" copy is CLIENT
 *      rendered, so the one check at navigation time ran too early and missed
 *      it. Re-asking after the page settles (`profileUnavailable`) names the
 *      link dead on the first try.
 *   2. THE LOOP ITSELF — a `network_error` defer had no budget. Even a link no
 *      check can classify must stop being retried eventually, which is what
 *      `networkDeferExhausted` bounds. This is the fix that holds regardless of
 *      what any future page shape does, and the one that ships server-side.
 *
 * Pure logic — no DB, no Redis, no browser, no LinkedIn traffic.
 */
import {
  MAX_NETWORK_DEFERS,
  networkDeferExhausted,
  failureText,
  isProfileGoneNav,
  DEFER_OUTCOMES,
  TERMINAL_FAIL_OUTCOMES,
} from '../src/modules/drivers/linkedin-driver.interface';
import { profileUnavailable, gotoProfile } from '../src/modules/drivers/playwright-linkedin.driver';
import type { NavigablePage } from '../src/modules/drivers/playwright-linkedin.driver';

/** A fake page whose body text is whatever we hand it. */
const pageShowing = (body: string) => ({
  locator: (sel: string) => ({
    async count() {
      const m = /^text=\/(.*)\/i$/s.exec(sel);
      if (!m) throw new Error(`unexpected selector: ${sel}`);
      return new RegExp(m[1], 'i').test(body) ? 1 : 0;
    },
  }),
});

/**
 * The page LinkedIn ACTUALLY serves for a dead profile, verified from a live
 * screenshot of /in/darwin-ponraj-77939020: a 302 to `linkedin.com/404/`, a 200,
 * and a body with neither <main> nor <h1> — only the illustration and the words
 * "This page doesn't exist".
 */
const deadProfilePage = (landsOn = 'https://www.linkedin.com/404/'): NavigablePage => {
  let here = 'about:blank';
  return {
    async goto() {
      here = landsOn; // the redirect has already resolved when the nav commits
      return { status: () => 200 }; // ← note: NOT a 404 status
    },
    url: () => here,
    async waitForLoadState() {},
    locator: () => ({
      first: () => ({
        // No <main>, no <h1> — the render probe can never be satisfied.
        async waitFor() {
          throw new Error('Timeout: locator("main, h1") never attached');
        },
      }),
    }),
  };
};

describe('a dead profile link stops being re-run', () => {
  describe("LinkedIn's /404/ redirect — the shape seen live", () => {
    it('reads the landed /404/ URL as gone', () => {
      expect(isProfileGoneNav('https://www.linkedin.com/404/')).toBe(true);
      expect(isProfileGoneNav('https://linkedin.com/404')).toBe(true);
      expect(isProfileGoneNav('https://in.linkedin.com/404/?trk=x')).toBe(true);
    });

    it('never mistakes a real profile whose slug contains 404', () => {
      expect(isProfileGoneNav('https://www.linkedin.com/in/john-404')).toBe(false);
      expect(isProfileGoneNav('https://www.linkedin.com/in/darwin-ponraj-77939020')).toBe(false);
      expect(isProfileGoneNav('https://evil-linkedin.com.attacker.io/404/')).toBe(false);
    });

    // 🔴 THE REGRESSION. The /404/ page fails the rendered-body probe, so before
    // the fix gotoProfile returned {resp: null, error: 'body never rendered'} —
    // a NULL response, which skipped every dead-link check downstream and made
    // the worker defer and re-drive the same dead URL every 10 minutes forever.
    it('answers 404 instead of "body never rendered", even though nothing renders', async () => {
      const nav = await gotoProfile(deadProfilePage(), 'https://www.linkedin.com/in/darwin-ponraj-77939020');
      expect(nav.error).toBeUndefined();
      expect(nav.resp).not.toBeNull();
      // Every caller classifies a 404 response as profile_gone — terminal, no retry.
      expect(nav.resp!.status()).toBe(404);
    });

    it('still reports a genuinely unrenderable REAL profile as retryable', async () => {
      const slow = deadProfilePage('https://www.linkedin.com/in/darwin-ponraj-77939020');
      const nav = await gotoProfile(slow, 'https://www.linkedin.com/in/darwin-ponraj-77939020');
      // Not a /404/ landing ⇒ we genuinely never got a page ⇒ defer, don't burn the lead.
      expect(nav.resp).toBeNull();
      expect(nav.error).toBe('body never rendered');
    });
  });

  describe('classification — the page says there is no profile here', () => {
    // The copy LinkedIn actually serves for a deleted / wrong /in/<slug>.
    it.each([
      ['This page doesn’t exist', 'curly apostrophe, the shape LinkedIn ships'],
      ["This page doesn't exist", 'straight apostrophe'],
      ['Page not found', 'the short 404 heading'],
      ['This profile is not available', 'deactivated member'],
      ['This account is no longer active', 'closed account'],
    ])('reads %j as gone (%s)', async (body) => {
      expect(await profileUnavailable(pageShowing(String(body)))).toBe(true);
    });

    it('does NOT fire on a real profile', async () => {
      expect(
        await profileUnavailable(pageShowing('Priya Raman | LinkedIn — Connect Message More')),
      ).toBe(false);
    });

    // A checkpoint means LinkedIn wants the human to verify a session it still
    // considers real. Different remedy, different outcome — never "profile gone".
    it('does NOT fire on a security checkpoint', async () => {
      expect(
        await profileUnavailable(pageShowing("Let's do a quick security check — verify it's you")),
      ).toBe(false);
    });

    it('names the dead link terminal and the slow link retryable', () => {
      expect(TERMINAL_FAIL_OUTCOMES).toContain('profile_gone');
      expect(DEFER_OUTCOMES).toContain('network_error');
      // 🔴 The invariant the retry loop must never break: a page that merely
      // failed to load is NOT a verdict about the lead.
      expect(TERMINAL_FAIL_OUTCOMES).not.toContain('network_error');
    });
  });

  describe('the retry budget — "later" never means "forever"', () => {
    it('retries a fresh failure and stops at the budget', () => {
      // attempts is the count of defers ALREADY spent on this job.
      const spent = [...Array(MAX_NETWORK_DEFERS).keys()]; // 0,1,2,3,4
      const verdicts = spent.map((a) => networkDeferExhausted(a));
      expect(verdicts.slice(0, -1).every((v) => v === false)).toBe(true);
      expect(verdicts[verdicts.length - 1]).toBe(true);
      // …so the job runs exactly MAX_NETWORK_DEFERS times, then fails.
      expect(verdicts.filter((v) => !v).length + 1).toBe(MAX_NETWORK_DEFERS);
    });

    it('treats a missing counter as a first attempt, not an exhausted one', () => {
      expect(networkDeferExhausted(undefined)).toBe(false);
      expect(networkDeferExhausted(null)).toBe(false);
    });

    it('never lets a stuck job slip past the budget', () => {
      expect(networkDeferExhausted(MAX_NETWORK_DEFERS + 50)).toBe(true);
    });

    it('gives the user a sentence, not an enum, when the link is given up on', () => {
      for (const code of ['profile_unreachable', 'profile_not_found']) {
        const text = failureText(code);
        expect(text).not.toBe(code);
        expect(text).toMatch(/link|profile|URL/i);
      }
    });
  });
});
