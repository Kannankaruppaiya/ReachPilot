/** Read-only: open the AGENT'S OWN signed-in Chrome profile, in the SAME headful
 *  mode the desktop agent uses, and dump exactly what directConnect() sees.
 *  No connect, no send, no login, no clicks.
 *
 *  npx ts-node -r tsconfig-paths/register scripts/_probe-topcard.ts <acctId> <url> [headless]
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const ACCT = process.argv[2];
const URL_ARG = process.argv[3];
const HEADLESS = process.argv[4] === 'headless';

(async () => {
  const { chromium } = await import('playwright');
  const dir = path.join(os.tmpdir(), 'reachpilot-profiles', ACCT);
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
  }
  const opts: any = { headless: HEADLESS, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] };
  let context;
  try { context = await chromium.launchPersistentContext(dir, { ...opts, channel: 'chrome' }); }
  catch { context = await chromium.launchPersistentContext(dir, opts); }

  const page = context.pages()[0] || (await context.newPage());
  const resp = await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);
  console.log(`mode: ${HEADLESS ? 'HEADLESS' : 'HEADFUL (same as agent)'}`);
  console.log(`landed: ${page.url()}`);
  console.log(`status: ${resp?.status()}   title: ${await page.title()}`);
  if (/authwall|\/login/i.test(page.url())) {
    console.log('>>> AUTHWALL — session throttled, results meaningless. Stopping.');
    await context.close(); process.exit(2);
  }

  const title = (await page.title()) || '';
  const nameHeading = title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*\|.*$/, '').trim();
  console.log(`\nnameHeading (from page title) = ${JSON.stringify(nameHeading)}`);

  // EVERY element on the page whose aria-label mentions connecting — the ground
  // truth directConnect() is matched against.
  const conns = await page.evaluate(() => {
    const out: any[] = [];
    document.querySelectorAll('[aria-label]').forEach((el: any) => {
      const a = el.getAttribute('aria-label') || '';
      if (/to connect/i.test(a)) {
        const r = el.getBoundingClientRect();
        out.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          aria: a,
          href: el.getAttribute('href') || '',
          txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
          shown: r.width > 0 && r.height > 0,
        });
      }
    });
    return out;
  }).catch(() => [] as any[]);

  const plain = nameHeading.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).join('\\s+');
  const re = new RegExp('^invite\\s+' + plain + '\\s+to connect$', 'i');
  console.log(`targetConnectRe = ${re}\n`);
  console.log(`elements with aria-label ~ /to connect/i  (${conns.length}):`);
  for (const c of conns) {
    console.log(`   [${re.test(c.aria) ? 'MATCH' : '  -  '}] <${c.tag} role="${c.role}"> shown=${c.shown ? 'Y' : 'n'} aria=${JSON.stringify(c.aria)} href="${String(c.href).slice(0, 50)}"`);
  }

  // Any visible control whose own text is just "Connect" (what a human sees).
  const plainConnect = await page.evaluate(() => {
    const out: any[] = [];
    document.querySelectorAll('button, a, [role="button"], [role="menuitem"]').forEach((el: any) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^connect$/i.test(t)) {
        const r = el.getBoundingClientRect();
        out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', aria: el.getAttribute('aria-label') || '', href: el.getAttribute('href') || '', shown: r.width > 0 && r.height > 0 });
      }
    });
    return out;
  }).catch(() => [] as any[]);
  console.log(`\ncontrols whose visible text is exactly "Connect" (${plainConnect.length}):`);
  for (const c of plainConnect) console.log(`   <${c.tag} role="${c.role}"> shown=${c.shown ? 'Y' : 'n'} aria="${c.aria}" href="${String(c.href).slice(0, 50)}"`);

  console.log(`\ndirectConnect() would resolve: button=${await page.getByRole('button', { name: re }).count().catch(() => 0)} link=${await page.getByRole('link', { name: re }).count().catch(() => 0)}`);

  // Top-card action bar as the driver's card-scope sees it.
  const main = page.locator('main').first();
  const nameNode = page.getByText(nameHeading, { exact: true }).first();
  const topCard = nameNode.locator(
    'xpath=ancestor::*[.//button[contains(@aria-label," to connect") or ' +
      'normalize-space(.)="Message" or normalize-space(.)="More" or normalize-space(.)="More actions"]][1]',
  );
  const cardFound = await topCard.count().catch(() => 0);
  console.log(`\nnameNode count=${await nameNode.count().catch(() => 0)}  topCard: ${cardFound > 0 ? 'RESOLVED' : 'NOT FOUND -> main'}`);
  if (cardFound > 0) {
    const info = await topCard.first().evaluate((el: any) => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute('class') || '').slice(0, 60),
      btns: Array.from(el.querySelectorAll('button')).slice(0, 10).map((b: any) => (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18)),
    })).catch(() => null);
    console.log(`topCard = ${JSON.stringify(info)}`);
    const nn = await nameNode.evaluate((el: any) => ({ tag: el.tagName.toLowerCase(), href: el.getAttribute('href') || '' })).catch(() => null);
    console.log(`nameNode = ${JSON.stringify(nn)}`);
  }
  const card: any = cardFound > 0 ? topCard : main;
  const cnt = async (l: any) => await l.count().catch(() => 0);
  console.log(`card-scope: Message=${await cnt(card.getByRole('button', { name: /^Message$/i }))} Follow=${await cnt(card.getByRole('button', { name: /^Follow$/i }))} More=${await cnt(card.getByRole('button', { name: /^More$/i }))} Pending=${await cnt(card.getByRole('button', { name: /^Pending$/i }))}`);
  console.log(`main-scope: Message=${await cnt(main.getByRole('button', { name: /^Message$/i }))} Follow=${await cnt(main.getByRole('button', { name: /^Follow$/i }))} More=${await cnt(main.getByRole('button', { name: /^More$/i }))}`);

  await page.screenshot({ path: path.join(os.tmpdir(), 'topcard.png') }).catch(() => undefined);
  console.log(`\nscreenshot: ${path.join(os.tmpdir(), 'topcard.png')}`);
  await context.close();
  process.exit(0);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
