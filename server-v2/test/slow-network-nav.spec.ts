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
  isSignedOutNav,
  isRequeueableFailure,
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
  /** Where the browser ended up — LinkedIn redirects a dead session to /login. */
  landsOn?: string;
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
    url() {
      return script.landsOn ?? URL;
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

/**
 * Regression: a SIGNED-OUT account failed every job it was handed.
 *
 * OBSERVED LIVE (narmatha@rjpinfotek.ooo, account 73fa5cf8, 2026-08-31
 * 15:10–17:01 IST). `_verify-session-store.ts` confirmed all three legs:
 *   - the vault held the LEGACY bare `li_at` (1 cookie, no JSESSIONID/bcookie/liap)
 *   - the browser profile held 15 cookies and NO `li_at` — LinkedIn had signed it out
 *   - /feed/ redirected to /login/
 *
 * Injecting that stale cookie made LinkedIn bounce /in/<slug> → /authwall →
 * /login → back until Chrome gave up, so 15 consecutive invites died as:
 *
 *   page.goto: net::ERR_TOO_MANY_REDIRECTS at http://www.linkedin.com/in/…
 *
 * …recorded as terminal `failed` with that raw string in `last_error`, no
 * notification, and the account left at status='connecting'. 15 live prospects
 * burned, 75 more queued to die the same way, and nothing told the user the one
 * thing that would fix it: reconnect the account.
 *
 * NOT a URL-format bug, though every failing URL looked malformed (`http://`,
 * `in.linkedin.com`). Verified in a signed-IN browser: both forms resolve to
 * https://www.linkedin.com in a single hop, and a pristine
 * `https://www.linkedin.com/in/vinay-hiremath/` redirect-looped just as hard.
 * The discriminator is the session, not the string.
 */
describe('gotoProfile — a signed-out account', () => {
  const REDIRECT_LOOP = () =>
    new Error(
      `page.goto: net::ERR_TOO_MANY_REDIRECTS at ${URL}\nCall log:\n  - navigating to "${URL}"`,
    );

  it('THE BUG: a redirect loop is reported as signedOut, not as a lead-level failure', async () => {
    const { page } = fakePage({ attempts: [{ throws: REDIRECT_LOOP() }] });

    const nav = await gotoProfile(page, URL);

    expect(nav.signedOut).toBe(true);
    expect(nav.resp).toBeNull();
  });

  it('does not retry a dead session — every retry is more unauthenticated traffic', async () => {
    const { page, calls } = fakePage({ attempts: [{ throws: REDIRECT_LOOP() }] });

    await gotoProfile(page, URL);

    expect(calls.goto).toBe(1); // a genuine network failure still gets its retry
  });

  it('also catches the clean load that simply LANDED on the sign-in wall', async () => {
    const { page } = fakePage({
      attempts: [{ status: 200 }],
      renders: true,
      documentCompletes: true,
      landsOn: 'https://www.linkedin.com/login/?session_redirect=%2Ffeed%2F',
    });

    const nav = await gotoProfile(page, URL);

    expect(nav.signedOut).toBe(true);
  });

  it('a healthy profile load is untouched', async () => {
    const { page } = fakePage({ attempts: [{ status: 200 }], renders: true });

    const nav = await gotoProfile(page, URL);

    expect(nav.signedOut).toBeUndefined();
    expect(nav.error).toBeUndefined();
  });

  it('a plain slow-link failure is still network_error, NOT signed out', async () => {
    const { page } = fakePage({ attempts: [{ throws: NAV_TIMEOUT() }] });

    const nav = await gotoProfile(page, URL);

    expect(nav.signedOut).toBeUndefined();
    expect(nav.error).toContain('Timeout');
  });

  it('halts the ACCOUNT rather than burning the lead', () => {
    // The whole point: one dead cookie must not consume a queue of prospects.
    expect(ACCOUNT_HALT_OUTCOMES).toContain('session_expired');
    expect(TERMINAL_FAIL_OUTCOMES).not.toContain('session_expired');
    expect(SKIP_OUTCOMES).not.toContain('session_expired');
    expect(DEFER_OUTCOMES).not.toContain('session_expired');
  });
});

/**
 * The DELIVERY half of the signed-out fix.
 *
 * The driver is esbuild-bundled into every user's desktop app, so a driver-only
 * fix reaches customers only if they download and reinstall a new build — which
 * is not something users can be asked to do for each bug. What makes this fix
 * shippable is that the classification is ALSO possible from what old app
 * versions already send: the agent hands back a generic `failed` carrying the
 * raw Playwright text, and the server can read it.
 *
 * These assert the predicate against the EXACT strings recorded in production
 * against narmatha@rjpinfotek.ooo, so the server-side path is known to fire for
 * agents that have never been updated.
 */
describe('isSignedOutNav — what an un-updated desktop agent sends', () => {
  const PROD_ERRORS = [
    'page.goto: net::ERR_TOO_MANY_REDIRECTS at http://www.linkedin.com/in/anand-raman-8446aa18\nCall log:\n  - navigating to "http://www.linkedin.com/in/anand-raman-8446aa18", waiting until "domcontentloaded"',
    'page.goto: net::ERR_TOO_MANY_REDIRECTS at https://www.linkedin.com/in/vinay-hiremath/',
    'page.goto: net::ERR_TOO_MANY_REDIRECTS at https://in.linkedin.com/in/vrinda-vishnoi-0926b651',
  ];

  it.each(PROD_ERRORS)('classifies the recorded production error: %s', (err) => {
    expect(isSignedOutNav('', err)).toBe(true);
  });

  it('reads the sign-in wall from a landed URL too', () => {
    expect(
      isSignedOutNav('https://www.linkedin.com/login/?session_redirect=%2Ffeed%2F', ''),
    ).toBe(true);
    expect(isSignedOutNav('https://www.linkedin.com/authwall?trk=bf', '')).toBe(true);
  });

  it('leaves a real security challenge to the checkpoint path', () => {
    // A challenge means LinkedIn still considers the session real — different
    // remedy (the human verifies), so it must NOT be read as signed out.
    expect(isSignedOutNav('https://www.linkedin.com/checkpoint/challenge/xyz', '')).toBe(false);
  });

  it('does not swallow an ordinary slow-link failure', () => {
    expect(isSignedOutNav('', 'page.goto: Timeout 30000ms exceeded.')).toBe(false);
    expect(isSignedOutNav('https://www.linkedin.com/in/someone/', '')).toBe(false);
  });
});

/**
 * The "Retry failed" button's safety rule.
 *
 * A failed row is normally a true verdict about the LEAD. The button exists for
 * the rows where it is not — an account that had been signed out failed every
 * job it touched while those prospects stayed perfectly contactable (17 of them
 * in one afternoon on narmatha@rjpinfotek.ooo).
 *
 * The rule is an ALLOWLIST, and these lock that down. The cost of a wrong YES is
 * a SECOND invite fired at a real person and a second pacing slot spent, so
 * anything that reached the invite composer — where "did it send?" is ambiguous
 * — must be refused. A denylist would silently admit every driver error code
 * added after this was written; that is why this is written the other way round.
 */
describe('isRequeueableFailure — what the Retry button may touch', () => {
  it('requeues the signed-out failures that burned live prospects', () => {
    expect(
      isRequeueableFailure(
        'page.goto: net::ERR_TOO_MANY_REDIRECTS at http://www.linkedin.com/in/anand-raman-8446aa18',
      ),
    ).toBe(true);
    expect(isRequeueableFailure('session_expired')).toBe(true);
    expect(isRequeueableFailure('network_error')).toBe(true);
    expect(isRequeueableFailure('agent_unavailable')).toBe(true);
  });

  it('requeues any navigation failure — the page never loaded, so nothing was clicked', () => {
    expect(isRequeueableFailure('page.goto: Timeout 30000ms exceeded.')).toBe(true);
    expect(isRequeueableFailure('nav_failed: page.goto: net::ERR_ABORTED')).toBe(true);
  });

  it('REFUSES real verdicts about the lead — retrying only fails them again', () => {
    for (const code of ['no_connect_button', 'profile_gone', 'blocked', 'email_required', 'note_cap']) {
      expect(isRequeueableFailure(code)).toBe(false);
    }
  });

  it('🔴 REFUSES anything that reached the invite composer — a send may have happened', () => {
    // The whole point of the allowlist. An ambiguous send must read as "sent",
    // because the alternative is inviting a real person twice.
    for (const code of [
      'invite_dialog_never_opened',
      'send_button_not_found',
      'invite_not_confirmed',
      'connect_target_mismatch',
      'locator.click: Timeout 12000ms exceeded.',
    ]) {
      expect(isRequeueableFailure(code)).toBe(false);
    }
  });

  it('refuses an empty or unknown reason rather than guessing', () => {
    expect(isRequeueableFailure(null)).toBe(false);
    expect(isRequeueableFailure('')).toBe(false);
    expect(isRequeueableFailure('some_code_invented_next_year')).toBe(false);
  });
});
