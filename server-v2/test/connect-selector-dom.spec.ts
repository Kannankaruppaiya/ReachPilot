/**
 * Regression: `no_connect_button` on a profile whose Connect control is right there.
 *
 * OBSERVED LIVE (2026-08-27, account 508cd4a6 / greatworksramesh, four leads in one
 * batch — Dinesh M, Ganesh Sankararaman, Achuthan Thiru, Aparna Gopalakrishnan —
 * all recorded `last_error = 'no_connect_button'` with no sub-reason).
 *
 * The DOM was read out of the operator's own signed-in browser on
 * linkedin.com/in/dinesh-m-84686222. LinkedIn renders Connect like this:
 *
 *   <a role="menuitem" aria-label=""                      <-- own label EMPTY
 *      href="/preload/custom-invite/?vanityName=dinesh-m-84686222">
 *     <div aria-label="Invite Dinesh M to connect">       <-- label here, NO role
 *       Connect
 *     </div>
 *   </a>
 *
 * The driver looked for it with
 *   getByRole('button', { name: /^invite <name> to connect$/i })
 *     .or(getByRole('link',   { name: ... }))
 * and that can NEVER resolve this control:
 *   - the <div> carries the matching accessible name but has no role at all, so
 *     it is neither a `button` nor a `link`;
 *   - the <a> has an explicit role="menuitem", which overrides the implicit
 *     `link` role, and its own aria-label is empty.
 *
 * So the miss is about ROLE and WHERE THE LABEL LIVES — not about the control
 * being hidden behind "More". The same markup on a top card fails identically,
 * which is what the operator reported ("direct-ah irundhaalum fire aagudhu").
 *
 * The fix matches the invite ANCHOR by its href, whose `vanityName` is the same
 * identity guard the deep-link path already applies — so it is role-independent
 * AND strictly target-scoped: the "People also viewed" rail carries its own
 * custom-invite anchors and must never be resolved.
 *
 * Real Chromium + `setContent` — no network, no LinkedIn traffic, no DB.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { connectControl } from '../src/modules/drivers/playwright-linkedin.driver';

const TARGET_SLUG = 'dinesh-m-84686222';
const TARGET_NAME = 'Dinesh M';

/** The shapes observed live, plus a rail person who must never be resolved. */
const FIXTURE = `
<main>
  <!-- TOP CARD: no direct Connect. Message is an <a>, not a button. -->
  <section id="top-card">
    <h1>Dinesh M</h1>
    <a href="/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAA">Message</a>
    <button aria-label="Follow Dinesh M">Follow</button>
    <button>More</button>
  </section>

  <!-- The opened "More" overflow, exactly as LinkedIn renders it. -->
  <div class="artdeco-dropdown__content--is-open" role="menu">
    <a role="menuitem" href="/preload/custom-invite/?vanityName=dinesh-m-84686222">
      <div aria-label="Invite Dinesh M to connect">Connect</div>
    </a>
    <a role="menuitem" href="/preload/report-in-modal/?entityUrn=urn%3Ali%3Amember%3A1">Report Dinesh</a>
  </div>

  <!-- "People also viewed" rail: a DIFFERENT person, with both of the shapes the
       matcher is allowed to accept. Resolving one of these is the wrong-invite bug. -->
  <aside id="rail">
    <button aria-label="Invite Sethuraman Elumalai to connect">Connect</button>
    <a role="menuitem" href="/preload/custom-invite/?vanityName=sethuraman-elumalai-99">
      <div aria-label="Invite Sethuraman Elumalai to connect">Connect</div>
    </a>
  </aside>
</main>`;

/** The matcher as it shipped — kept here only to pin the defect it caused. */
const roleOnlyMatcher = (page: Page) => {
  const re = new RegExp(`^invite\\s+${TARGET_NAME.replace(/\s+/g, '\\s+')}\\s+to connect$`, 'i');
  return page.getByRole('button', { name: re }).or(page.getByRole('link', { name: re }));
};

describe('Connect control resolution on the live LinkedIn DOM', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.setContent(FIXTURE);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('the shipped role-based matcher cannot see this Connect at all', async () => {
    // Not an aspiration — this is the production failure, pinned. The target's
    // own Connect is on the page and visible, and the matcher still finds zero.
    await expect(page.locator('[aria-label="Invite Dinesh M to connect"]').isVisible()).resolves.toBe(true);
    await expect(roleOnlyMatcher(page).count()).resolves.toBe(0);
  });

  it('resolves the target Connect anchor', async () => {
    const loc = connectControl(page, { nameHeading: TARGET_NAME, targetSlug: TARGET_SLUG });
    await expect(loc.count()).resolves.toBeGreaterThan(0);

    const href = await loc.first().getAttribute('href');
    expect(href).toContain(`vanityName=${TARGET_SLUG}`);
  });

  it('never resolves a rail person, whichever shape they are rendered in', async () => {
    const loc = connectControl(page, { nameHeading: TARGET_NAME, targetSlug: TARGET_SLUG });
    const hrefs = await loc.evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('href') || ''));
    for (const h of hrefs) expect(h).not.toContain('sethuraman');

    // And the rail's own name must resolve only the rail's own control.
    const rail = connectControl(page, {
      nameHeading: 'Sethuraman Elumalai',
      targetSlug: 'sethuraman-elumalai-99',
    });
    await expect(rail.count()).resolves.toBeGreaterThan(0);
    const railHrefs = await rail.evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('href') || ''));
    for (const h of railHrefs) expect(h).not.toContain(TARGET_SLUG);
  });

  it('still resolves a plain <button> Connect (the shape that already worked)', async () => {
    const p2 = await browser.newPage();
    await p2.setContent(
      `<main><h1>Uma Sanjeeviraman</h1>
        <button aria-label="Invite Uma Sanjeeviraman to connect">Connect</button>
      </main>`,
    );
    const loc = connectControl(p2, { nameHeading: 'Uma Sanjeeviraman', targetSlug: '' });
    await expect(loc.count()).resolves.toBe(1);
    await p2.close();
  });
});
