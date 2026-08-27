/**
 * Regression: a SLOW link turned healthy leads into permanent failures.
 *
 * OBSERVED LIVE (job f88147ac, account 508cd4a6, link measured at ~15 kB/s with
 * 16 % packet loss):
 *
 *   target = linkedin.com/in/ACwAAAU0vUABwfrtY62Gqd90xSI4QKoYEcqst_o
 *   err    = page.goto: Timeout 30000ms exceeded.
 *            - navigating to "...", waiting until "domcontentloaded"
 *
 * The tab visibly rendered the target's profile — name, headline and the Connect
 * button all on screen — while `page.goto` threw, because a 1–2 MB profile
 * document does not finish streaming inside 30 s at that speed. The driver's
 * `finally` then closed the context (the "tab closes by itself" symptom) and the
 * job was recorded as failed.
 *
 * Two separate defects, both covered here:
 *   1. NAVIGATION waited on the wrong signal (document-complete) with an
 *      arbitrary cap, instead of on the condition it actually needed (a rendered
 *      body). Fixed by `gotoProfile`.
 *   2. CLASSIFICATION treated "we never got a usable page" as a terminal verdict
 *      about the lead (`no_connect_button`, never retried). Fixed by the
 *      `network_error` outcome, which the worker defers.
 *
 * Pure logic — no DB, no Redis, no browser, no LinkedIn traffic.
 */
import { gotoProfile } from '../src/modules/drivers/playwright-linkedin.driver';
import type { NavigablePage, NavResponse } from '../src/modules/drivers/playwright-linkedin.driver';
import {
  TERMINAL_FAIL_OUTCOMES,
  DEFER_OUTCOMES,
  SKIP_OUTCOMES,
  ACCOUNT_HALT_OUTCOMES,
} from '../src/modules/drivers/linkedin-driver.interface';

const URL = 'https://www.linkedin.com/in/ACwAAAU0vUABwfrtY62Gqd90xSI4QKoYEcqst_o';

/** The exact Playwright rejection seen in production. */
const NAV_TIMEOUT = () =>
  new Error(
    `page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "${URL}", waiting until "domcontentloaded"`,
  );

type PageScript = {
  /** One entry per navigation attempt: throw, or the response to return. */
  attempts: Array<{ throws?: Error; status?: number }>;
  /** Whether the body ever renders once a navigation commits. */
  renders?: boolean;
  /** Whether the document ever reaches domcontentloaded. */
  documentCompletes?: boolean;
};

/** A Page-shaped fake. Records what the navigation policy actually did. */
function fakePage(script: PageScript) {
  const calls = { goto: 0, waitForLoadState: 0, renderProbe: 0 };
  let i = 0;
  const page: NavigablePage = {
    async goto(_url, opts) {
      calls.goto++;
      // The fix must commit the navigation, not wait for the document.
      expect(opts.waitUntil).toBe('commit');
      const step = script.attempts[Math.min(i++, script.attempts.length - 1)];
      if (step.throws) throw step.throws;
      const resp: NavResponse = { status: () => step.status ?? 200 };
      return resp;
    },
    async waitForLoadState(_state, _opts) {
      calls.waitForLoadState++;
      if (!script.documentCompletes) throw new Error('Timeout exceeded');
    },
    locator(_selector) {
      return {
        first: () => ({
          async waitFor(_o) {
            calls.renderProbe++;
            if (!script.renders) throw new Error('Timeout exceeded');
          },
        }),
      };
    },
  };
  return { page, calls };
}

describe('gotoProfile — the production failure', () => {
  it('THE BUG: a page that RENDERED but whose document never completed now succeeds', async () => {
    // Exactly the observed state: Connect visible on screen, HTML still streaming.
    const { page, calls } = fakePage({
      attempts: [{ status: 200 }],
      renders: true,
      documentCompletes: false,
    });

    const nav = await gotoProfile(page, URL);

    expect(nav.error).toBeUndefined(); // previously: "Timeout 30000ms exceeded"
    expect(nav.resp?.status()).toBe(200);
    expect(calls.goto).toBe(1); // no wasted retry — the page was fine
    expect(calls.renderProbe).toBe(1); // decided on the body, not the document
  });

  it('a slow document that does complete is likewise fine', async () => {
    const { page } = fakePage({ attempts: [{ status: 200 }], renders: true, documentCompletes: true });
    const nav = await gotoProfile(page, URL);
    expect(nav.error).toBeUndefined();
    expect(nav.resp?.status()).toBe(200);
  });
});

describe('gotoProfile — retry policy', () => {
  it('retries once when the connection drops, and succeeds on the retry', async () => {
    const { page, calls } = fakePage({
      attempts: [{ throws: NAV_TIMEOUT() }, { status: 200 }],
      renders: true,
    });
    const retries: string[] = [];

    const nav = await gotoProfile(page, URL, (reason) => retries.push(reason));

    expect(nav.error).toBeUndefined();
    expect(calls.goto).toBe(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain('page.goto: Timeout');
    // The retry reason is the FIRST line only — the multi-line Playwright call
    // log must not be smuggled into a DB `last_error` column.
    expect(retries[0]).not.toContain('\n');
  });

  it('gives up after two attempts and reports a navigation failure', async () => {
    const { page, calls } = fakePage({
      attempts: [{ throws: NAV_TIMEOUT() }, { throws: NAV_TIMEOUT() }],
      renders: true,
    });

    const nav = await gotoProfile(page, URL);

    expect(calls.goto).toBe(2);
    expect(nav.resp).toBeNull();
    expect(nav.error).toContain('page.goto: Timeout');
  });

  it('reports a failure when the body never renders at all', async () => {
    const { page } = fakePage({ attempts: [{ status: 200 }], renders: false });
    const nav = await gotoProfile(page, URL);
    expect(nav.error).toBe('body never rendered');
  });

  it('does NOT burn a retry on a 404 — that is a real answer, not a slow page', async () => {
    const { page, calls } = fakePage({ attempts: [{ status: 404 }], renders: false });

    const nav = await gotoProfile(page, URL);

    expect(nav.error).toBeUndefined();
    expect(nav.resp?.status()).toBe(404); // caller classifies this as profile_gone
    expect(calls.goto).toBe(1);
    expect(calls.renderProbe).toBe(0); // never waited on a body that isn't coming
  });
});

describe('network_error classification', () => {
  it('is NOT terminal — a bad link must never permanently burn a lead', () => {
    expect(TERMINAL_FAIL_OUTCOMES).not.toContain('network_error');
  });

  it('is deferred, so the scheduler re-drives it', () => {
    expect(DEFER_OUTCOMES).toContain('network_error');
  });

  it('is not silently treated as a skip or an account halt', () => {
    expect(SKIP_OUTCOMES).not.toContain('network_error');
    expect(ACCOUNT_HALT_OUTCOMES).not.toContain('network_error');
  });

  it('the defer and terminal sets stay disjoint', () => {
    for (const o of DEFER_OUTCOMES) expect(TERMINAL_FAIL_OUTCOMES).not.toContain(o);
  });

  it('REGRESSION: the terminal set still holds the genuinely terminal outcomes', () => {
    // Guards against a future "just defer everything" loosening.
    expect(TERMINAL_FAIL_OUTCOMES).toEqual(
      expect.arrayContaining(['no_connect_button', 'profile_gone', 'blocked']),
    );
  });
});
