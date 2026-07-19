import { chromium } from 'playwright';
import { authenticator } from 'otplib';

const EMAIL = process.argv[2];
const PASSWORD = process.argv[3];
const TOTP = process.argv[4];
const SHOT = 'C:/Users/Kannan/AppData/Local/Temp/claude/li-2fa.png';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const c = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-IN', timezoneId: 'Asia/Kolkata',
  });
  const page = await c.newPage();
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(2500);
  await page.locator('input[autocomplete="username"], input[type="email"]').filter({ visible: true }).first().fill(EMAIL);
  await page.locator('input[type="password"]').filter({ visible: true }).first().fill(PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/ }).first().click();
  await page.waitForTimeout(6000);

  console.log('2FA URL:', page.url());
  const txt = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
  console.log('2FA TEXT:\n', txt.replace(/\n{2,}/g, '\n'));

  console.log('--- PIN input candidates ---');
  for (const s of ['input[name="pin"]', '#input__phone_verification_pin', 'input[autocomplete="one-time-code"]', 'input[type="tel"]', 'input[type="text"]']) {
    console.log('  ', await page.locator(s).count(), s);
  }
  // fill PIN if an input exists
  const pin = authenticator.generate(TOTP);
  const pinLoc = page.locator('input[name="pin"], #input__phone_verification_pin, input[autocomplete="one-time-code"], input[type="tel"]').filter({ visible: true }).first();
  if (await pinLoc.count()) { await pinLoc.fill(pin); console.log('filled PIN:', pin); }

  console.log('--- ALL BUTTONS on page ---');
  const btns = page.locator('button, input[type="submit"]');
  const n = await btns.count();
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    const t = (await b.innerText().catch(() => '')).trim().slice(0, 40);
    const id = await b.getAttribute('id').catch(() => '');
    const type = await b.getAttribute('type').catch(() => '');
    const aria = await b.getAttribute('aria-label').catch(() => '');
    const vis = await b.isVisible().catch(() => false);
    if (t || id || aria) console.log(`  [${vis ? 'vis' : 'hid'}] text="${t}" id="${id}" type="${type}" aria="${aria}"`);
  }
  await page.screenshot({ path: SHOT });
  console.log('screenshot:', SHOT);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
