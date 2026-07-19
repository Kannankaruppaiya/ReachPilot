/**
 * Temporary: read-only probe of what the AUTOMATION's browser actually sees on a
 * profile. Navigates under the account's real session/proxy/fingerprint and dumps
 * the signals sendConnectRequest branches on. Performs no connect/send action.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/_probe-profile.ts <profileUrl>
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { LinkedInSessionService } from '../src/modules/drivers/linkedin-session.service';

const URL_ARG = process.argv[2] || 'https://in.linkedin.com/in/darshana-karnik-39b2b441';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const sessions = app.get(LinkedInSessionService);
  const db = getDb();

  // Find the sendable account (RLS: scan workspaces).
  let acct: any, wsId = '';
  for (const ws of await db.selectFrom('workspaces').select(['id']).execute()) {
    const rows = (await withWorkspace(ws.id, (d: any) =>
      d.selectFrom('linkedin_accounts').select(['id', 'email', 'status', 'session_secret_id']).execute(),
    ).catch(() => [])) as any[];
    const found = rows.find((r) => r.session_secret_id && !['checkpoint', 'paused', 'disconnected'].includes(r.status));
    if (found) { acct = found; wsId = ws.id; break; }
  }
  if (!acct) { console.log('no sendable account'); process.exit(1); }
  console.log(`account: ${acct.email} [${acct.id.slice(0, 8)}] status=${acct.status}`);

  const ctx = await sessions.buildActionContext(acct.id, wsId);
  if (!ctx) { console.log('buildActionContext returned null'); process.exit(1); }
  console.log(`li_at present: ${ctx.li_at ? 'YES (len ' + ctx.li_at.length + ')' : 'NO'}`);
  console.log(`proxy: ${ctx.proxy ? ctx.proxy.server : '(direct / local IP)'}`);
  console.log(`fingerprint: tz=${ctx.fingerprint?.timezoneId} locale=${ctx.fingerprint?.locale}\n`);

  const { chromium } = await import('playwright');
  const os = await import('os'); const path = await import('path'); const fs = await import('fs');
  const dir = path.join(os.tmpdir(), 'reachpilot-profiles', ctx.accountId || 'default');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
  }

  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    userAgent: ctx.fingerprint?.userAgent,
    locale: ctx.fingerprint?.locale,
    timezoneId: ctx.fingerprint?.timezoneId,
    viewport: ctx.fingerprint?.viewport,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  } as any);
  if (ctx.li_at) {
    await context.addCookies([{ name: 'li_at', value: ctx.li_at, domain: '.linkedin.com', path: '/' }]);
  }

  const page = context.pages()[0] || (await context.newPage());
  const resp = await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  console.log(`--- what the automation sees ---`);
  console.log(`requested: ${URL_ARG}`);
  console.log(`landed on: ${page.url()}`);
  console.log(`http status: ${resp?.status()}`);
  console.log(`page title: ${await page.title()}`);

  // Is the session actually authenticated? The global nav only renders when logged in.
  const loggedIn = await page.locator('nav, .global-nav, [data-test-global-nav]').count().catch(() => 0);
  const authwall = /authwall|login|signup|checkpoint/i.test(page.url());
  console.log(`\nauthenticated? nav=${loggedIn > 0 ? 'present' : 'ABSENT'} authwallUrl=${authwall}`);

  // THE branch that returns no_connect_button with no logging:
  const h1 = ((await page.locator('main h1').first().innerText().catch(() => '')) || '').trim();
  console.log(`main h1 = "${h1}"`);
  console.log(`  → matches /^LinkedIn Member$/i ? ${/^LinkedIn Member$/i.test(h1)}  ${/^LinkedIn Member$/i.test(h1) ? '*** THIS IS WHY no_connect_button ***' : ''}`);

  const anyH1 = await page.locator('h1').allInnerTexts().catch(() => []);
  console.log(`all h1s: ${JSON.stringify(anyH1)}`);

  // What controls exist in the top card?
  const scan = async (root: any, label: string) => {
    const bs = root.getByRole('button');
    const n = Math.min(await bs.count().catch(() => 0), 30);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const b = bs.nth(i);
      const t = ((await b.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      const a = ((await b.getAttribute('aria-label').catch(() => '')) || '').trim();
      if (t || a) out.push(`${t || '(no text)'} | aria="${a}"`);
    }
    console.log(`\n${label} buttons (${n}):`);
    out.forEach((o) => console.log('   ' + o));
  };
  await scan(page.locator('main').first(), 'main');

  const connectCount = await page.getByRole('button', { name: /invite .* to connect|^connect$/i }).count().catch(() => 0);
  const followCount = await page.getByRole('button', { name: /^Follow$/i }).count().catch(() => 0);
  const msgCount = await page.getByRole('button', { name: /^Message$/i }).count().catch(() => 0);
  const pendingCount = await page.getByRole('button', { name: /^Pending$/i }).count().catch(() => 0);
  console.log(`\nconnect=${connectCount} follow=${followCount} message=${msgCount} pending=${pendingCount}`);

  // Open the More overflow READ-ONLY (opening a dropdown sends nothing) and dump
  // its items — this is where the driver finds Connect on the current DOM.
  const more = page.locator('main').first().getByRole('button', { name: /^More$/i })
    .or(page.locator('main').first().getByRole('button', { name: /^More actions$/i })).first();
  console.log(`\nMore button found: ${(await more.count().catch(() => 0)) > 0}`);
  if (await more.count().catch(() => 0)) {
    await more.scrollIntoViewIfNeeded().catch(() => undefined);
    await more.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const items = page.getByRole('menuitem');
    const n = Math.min(await items.count().catch(() => 0), 20);
    console.log(`menu items (${n}):`);
    for (let i = 0; i < n; i++) {
      const it = items.nth(i);
      const t = ((await it.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      const a = ((await it.getAttribute('aria-label').catch(() => '')) || '').trim();
      const inner = ((await it.locator('[aria-label]').first().getAttribute('aria-label').catch(() => '')) || '').trim();
      console.log(`   "${t}" | aria="${a}" | childAria="${inner}"`);
    }
    const connectInMenu = await page.getByRole('menuitem', { name: /invite .* to connect|^connect$/i }).count().catch(() => 0);
    console.log(`\n>>> Connect resolvable in menu via driver's selector? ${connectInMenu > 0 ? 'YES' : 'NO'} (count=${connectInMenu})`);

    // Candidate replacements — which locator strategy ACTUALLY finds Connect?
    const strategies: Record<string, string> = {
      "componentkey*=_connect": '[componentkey*="_connect"]',
      "componentkey^=ConnectButton": '[componentkey^="ConnectButtonstate:invitation:"]',
      'aria-label*="to connect"': '[aria-label*="to connect" i]',
      'menuitem:has-text(Connect)': 'a[role="menuitem"]:has-text("Connect")',
      'menuitem has aria child': 'a[role="menuitem"]:has([aria-label*="to connect" i])',
    };
    console.log('\n--- locator strategy comparison ---');
    for (const [label, sel] of Object.entries(strategies)) {
      try {
        const c = await page.locator(sel).count();
        const vis = c > 0 ? await page.locator(sel).first().isVisible().catch(() => false) : false;
        console.log(`   ${c > 0 ? '✓' : '✗'} ${label.padEnd(28)} count=${c} visible=${vis}`);
      } catch (e: any) {
        console.log(`   ! ${label.padEnd(28)} THREW: ${String(e.message).split('\n')[0].slice(0, 110)}`);
      }
    }
    try {
      const ck = await page.locator('[componentkey*="_connect"]').first().getAttribute('componentkey');
      console.log(`   resolved componentkey: ${ck}`);
    } catch (e: any) {
      console.log(`   resolved componentkey THREW: ${String(e.message).split('\n')[0].slice(0, 110)}`);
    }
    await page.keyboard.press('Escape').catch(() => undefined);
  }

  await page.screenshot({ path: path.join(os.tmpdir(), 'probe-profile.png'), fullPage: false }).catch(() => undefined);
  console.log(`\nscreenshot: ${path.join(os.tmpdir(), 'probe-profile.png')}`);

  await context.close();
  await app.close();
  process.exit(0);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
