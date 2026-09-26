/**
 * Regression: a dead profile link was re-run every 10 minutes forever. It looked
 * like a slow page (`network_error`), and deferrals had no budget. Covers the
 * late-rendered "doesn't exist" check (`profileUnavailable`), the /404/ redirect,
 * and the defer budget (`networkDeferExhausted`). Pure logic.
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
 * What LinkedIn serves for a dead profile: a redirect to `linkedin.com/404/`, a
 * 200, and a body with neither <main> nor <h1>.
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

    // 🔴 The regression: the /404/ page fails the body probe, and a null response
    // skipped every dead-link check downstream.
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

    // A checkpoint is a live session the human must verify, never "profile gone".
    it('does NOT fire on a security checkpoint', async () => {
      expect(
        await profileUnavailable(pageShowing("Let's do a quick security check — verify it's you")),
      ).toBe(false);
    });

    it('names the dead link terminal and the slow link retryable', () => {
      expect(TERMINAL_FAIL_OUTCOMES).toContain('profile_gone');
      expect(DEFER_OUTCOMES).toContain('network_error');
      // 🔴 A page that failed to load is not a verdict about the lead.
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
