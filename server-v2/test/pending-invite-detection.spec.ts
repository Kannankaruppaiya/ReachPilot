/**
 * Regression: a lead whose invite HAD gone out was recorded `failed`.
 *
 * OBSERVED LIVE (2026-08-27, job a23bdc60, Karthik Athreyan): LinkedIn showed
 * "Pending" on his profile — the invitation was genuinely delivered — while the
 * jobs table read `status=failed, last_error=no_connect_button`, and the app
 * listed him under Failed.
 *
 * Read out of the operator's signed-in browser on karthik-athreyan-17652950:
 *
 *   <a aria-label="Pending, click to withdraw invitation sent to Karthik Athreyan">
 *     Pending
 *   </a>
 *
 * It is an <a>, and its accessible name is the whole withdraw sentence — so
 * `getByRole('button', { name: /^Pending$/i })` matched nothing. Measured on that
 * page: ZERO Pending *buttons* existed, page-wide, not merely outside the top-card
 * scope. Since LinkedIn REPLACES Connect with Pending once an invite is
 * outstanding, the driver then found no Connect and returned `no_connect_button`,
 * which is in TERMINAL_FAIL_OUTCOMES — so the lead was burned permanently even
 * though the invite had been delivered.
 *
 * The same page also carries "Message <other person>" anchors for rail people, so
 * the check has to be constrained to THIS target's name.
 *
 * Real Chromium + `setContent` — no network, no LinkedIn traffic, no DB.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { pendingControl, connectedControl } from '../src/modules/drivers/playwright-linkedin.driver';
import { SKIP_OUTCOMES, TERMINAL_FAIL_OUTCOMES } from '../src/modules/drivers/linkedin-driver.interface';

const NAME = 'Karthik Athreyan';

/** The live markup: Pending as an <a>, plus rail controls naming other people. */
const FIXTURE = `
<main>
  <h1>${NAME}</h1>
  <div id="action-bar">
    <a href="/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAA">Message</a>
    <a aria-label="Pending, click to withdraw invitation sent to ${NAME}">Pending</a>
    <button aria-label="Follow ${NAME}">Follow</button>
    <button>More</button>
  </div>
  <aside id="rail">
    <a aria-label="Message Dharmarajan Visvanathan  " href="/messaging/compose/?x=1">Message</a>
    <a aria-label="Pending, click to withdraw invitation sent to Saryu Garg">Pending</a>
  </aside>
</main>`;

describe('outstanding-invite ("Pending") detection on the live LinkedIn DOM', () => {
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

  it('pending is treated as "already done", never as a lead failure', () => {
    // The whole point: this outcome must not burn the lead.
    expect(SKIP_OUTCOMES).toContain('pending');
    expect(TERMINAL_FAIL_OUTCOMES).not.toContain('pending');
  });

  it('the shipped role-based check could not see it', async () => {
    await expect(page.getByRole('button', { name: /^Pending$/i }).count()).resolves.toBe(0);
  });

  it('resolves the target-s outstanding invite', async () => {
    const loc = pendingControl(page, NAME);
    await expect(loc.count()).resolves.toBe(1);
    await expect(loc.first().getAttribute('aria-label')).resolves.toContain(NAME);
  });

  it('never matches a rail person-s pending invite', async () => {
    const labels = await pendingControl(page, NAME).evaluateAll((els: Element[]) =>
      els.map((e) => e.getAttribute('aria-label') || ''),
    );
    for (const l of labels) expect(l).not.toContain('Saryu Garg');

    // ...and the rail person's own name resolves only their control.
    const other = await pendingControl(page, 'Saryu Garg').evaluateAll((els: Element[]) =>
      els.map((e) => e.getAttribute('aria-label') || ''),
    );
    expect(other).toHaveLength(1);
    expect(other[0]).toContain('Saryu Garg');
  });

  it('still resolves a plain <button> Pending (older layout)', async () => {
    const p2 = await browser.newPage();
    await p2.setContent(`<main><h1>Uma S</h1><button>Pending</button></main>`);
    await expect(pendingControl(p2, 'Uma S').count()).resolves.toBe(1);
    await p2.close();
  });
});

describe('accepted-connection detection on the live LinkedIn DOM', () => {
  let browser: Browser;
  let page: Page;

  /**
   * An ACCEPTED connection has neither Connect nor Pending — only Message, and
   * Message is an <a>. Observed on Dinesh M after he accepted (profile reads
   * "· 1st"): a duplicate job recorded `no_connect_button`, i.e. a failure row
   * for a connection already won. The rail's "Message <other person>" anchors on
   * the same page must not satisfy the check.
   */
  const ACCEPTED = `
    <main>
      <h1>Dinesh M</h1>
      <a href="/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAA">Message</a>
      <button>More</button>
      <aside>
        <a aria-label="Message Chandana kumar Jena  " href="/messaging/compose/?x=1">Message</a>
        <a aria-label="Message Saryu Garg  " href="/messaging/compose/?x=2">Message</a>
      </aside>
    </main>`;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.setContent(ACCEPTED);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('already_connected is a skip, never a lead failure', () => {
    expect(SKIP_OUTCOMES).toContain('already_connected');
    expect(TERMINAL_FAIL_OUTCOMES).not.toContain('already_connected');
  });

  it('the shipped button-only check could not see it', async () => {
    await expect(page.getByRole('button', { name: /^Message$/i }).count()).resolves.toBe(0);
  });

  it("resolves only the target's compose link, never a rail person's", async () => {
    const loc = connectedControl(page);
    await expect(loc.count()).resolves.toBe(1);
    await expect(loc.first().getAttribute('aria-label')).resolves.toBeNull();
  });
});
