/**
 * Regression: the "More" menu path was unreachable. The top card shows only Follow
 * and More (labelled "More", never "More actions"), and the invite anchor exists
 * only after the menu opens. Pins the page-wide `^More$` tier and the path
 * trigger → dropdown → Connect item → invite anchor.
 * Real Chromium + setContent; no network.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { SELECTORS, resolveFirst, type SelectorScope } from '../src/modules/drivers/linkedin-selectors';

const SLUG = 'ganesh-sankararaman-425ba926';
const NAME = 'Ganesh Sankararaman';

/** Live shapes. `#top-card` lacks the action bar, like the broken card scope the driver computes. */
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

    // The driver takes the deep-link route from this href and guards on vanityName.
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
