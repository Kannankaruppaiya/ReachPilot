/**
 * Regression: the overflow ("More") path was unreachable, which is what actually
 * turned four live leads into terminal `no_connect_button` on 2026-08-27.
 *
 * READ OUT OF THE OPERATOR'S OWN SIGNED-IN BROWSER, on four separate profiles
 * (dinesh-m-84686222, ganesh-sankararaman-425ba926, achuthan-thiru-bb761440,
 * sethuraman-elumalai-b3179b55) — the current LinkedIn profile DOM behaves like
 * this, every time:
 *
 *   - The top card renders NO Connect at all. Just `Follow` and `More`
 *     (`Message` is an <a>, not a button).
 *   - The invite anchor does not exist in the document until the overflow is
 *     opened. Measured on ganesh-sankararaman-425ba926:
 *         BEFORE More opened -> a[href*="custom-invite"] : 0 matches
 *         AFTER  More opened -> a[href*="custom-invite"] : 1 match
 *     So no page-wide "find the Connect control" tier can ever help here; the
 *     menu HAS to be opened first.
 *   - The overflow trigger is labelled "More" — never "More actions":
 *         page-wide ^More$        : 2 visible
 *         page-wide ^More actions$: 0
 *
 * The card-scoped `moreButton` tiers miss whenever the top-card scope resolves to
 * the wrong subtree, and the only page-scoped tier asked for `^More actions$`.
 * With every tier missing, `more` came back null and the driver returned the bare
 * `no_connect_button` seen in the jobs table — WITHOUT EVER OPENING THE MENU that
 * holds the Connect control.
 *
 * Fix: a page-wide `^More$` tier. This spec pins the whole recovered path against
 * the real markup: trigger -> dropdown container -> Connect item -> invite anchor.
 *
 * Real Chromium + `setContent` — no network, no LinkedIn traffic, no DB.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { SELECTORS, resolveFirst, type SelectorScope } from '../src/modules/drivers/linkedin-selectors';

const SLUG = 'ganesh-sankararaman-425ba926';
const NAME = 'Ganesh Sankararaman';

/**
 * The live shapes. `#top-card` deliberately does NOT contain the action bar —
 * that is the broken card scope the driver actually computes, and the reason the
 * card-scoped tiers return nothing.
 */
const FIXTURE = `
<main>
  <section id="top-card"><h1>${NAME}</h1></section>

  <div id="action-bar">
    <a href="/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAA">Message</a>
    <button aria-label="Follow ${NAME}">Follow</button>
    <button>More</button>
  </div>

  <!-- The overflow, as LinkedIn renders it once opened: hashed class names, so
       the artdeco-dropdown__content selectors no longer match. role="menu" holds. -->
  <div role="menu" class="eb4cf114 ff70163b _4d19b25e">
    <a role="menuitem" href="/messaging/thread/new/">Send profile in a message</a>
    <a role="menuitem" href="/preload/custom-invite/?vanityName=${SLUG}">
      <div aria-label="Invite ${NAME} to connect">Connect</div>
    </a>
    <a role="menuitem" href="/preload/report-in-modal/?entityUrn=urn%3Ali%3Amember%3A1">Report Ganesh</a>
  </div>
</main>`;

describe('overflow ("More") path on the live LinkedIn DOM', () => {
  let browser: Browser;
  let page: Page;
  let scope: SelectorScope;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.setContent(FIXTURE);
    // The broken card scope, reproduced: it holds the name but no action control.
    scope = { page, card: page.locator('#top-card') };
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('the card scope really does contain no action control (the precondition)', async () => {
    await expect(page.locator('#top-card').getByRole('button', { name: /^More$/i }).count()).resolves.toBe(0);
    await expect(page.locator('#top-card').getByRole('button', { name: /^Message$/i }).count()).resolves.toBe(0);
  });

  it('the trigger is labelled "More", never "More actions"', async () => {
    await expect(page.getByRole('button', { name: /^More$/i }).count()).resolves.toBe(1);
    await expect(page.getByRole('button', { name: /^More actions$/i }).count()).resolves.toBe(0);
  });

  it('resolves the More trigger despite the broken card scope', async () => {
    const more = await resolveFirst(scope, SELECTORS.moreButton, 'moreButton');
    expect(more).not.toBeNull();
    await expect(more!.textContent()).resolves.toContain('More');
  });

  it('resolves the opened dropdown container even with hashed class names', async () => {
    const dd = await resolveFirst(scope, SELECTORS.dropdownContent, 'dropdownContent');
    expect(dd).not.toBeNull();
    await expect(dd!.getAttribute('role')).resolves.toBe('menu');
  });

  it('resolves the Connect item inside that dropdown, and it is the invite anchor', async () => {
    const dd = await resolveFirst(scope, SELECTORS.dropdownContent, 'dropdownContent');
    const menuScope: SelectorScope = { ...scope, menu: dd!.filter({ visible: true }).first() };

    const item = await resolveFirst(menuScope, SELECTORS.connectMenuItem, 'connectMenuItem');
    expect(item).not.toBeNull();

    // The driver reads this href to take the deep-link route, and guards on the
    // vanityName matching the target — so it must be the anchor, not the label div.
    const href = await item!.evaluate((el) =>
      el.tagName === 'A' ? el.getAttribute('href') : el.closest('a')?.getAttribute('href') || null,
    );
    expect(href).toContain(`vanityName=${SLUG}`);
  });

  it('the Connect item carries its label on a child, not on itself', async () => {
    // Documents WHY role+name matching failed: the anchor's own label is empty.
    const anchor = page.locator(`a[href*="vanityName=${SLUG}"]`);
    await expect(anchor.getAttribute('aria-label')).resolves.toBeNull();
    await expect(anchor.locator('[aria-label]').getAttribute('aria-label')).resolves.toBe(
      `Invite ${NAME} to connect`,
    );
  });
});
