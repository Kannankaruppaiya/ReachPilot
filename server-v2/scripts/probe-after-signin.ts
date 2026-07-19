import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { LinkedInSessionService } from '../src/modules/drivers/linkedin-session.service';
import { chromium } from 'playwright';

const SHOT = 'C:/Users/Kannan/AppData/Local/Temp/claude/li-after-signin.png';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule);
  const sessions = app.get(LinkedInSessionService);
  const db = getDb();

  const wss = await db.selectFrom('workspaces').select('id').execute();
  let target: { id: string; ws: string } | null = null;
  for (const w of wss) {
    const rows = await withWorkspace(w.id, (d) =>
      d.selectFrom('linkedin_accounts').select(['id', 'totp_secret_id', 'password_secret_id']).execute(),
    );
    for (const r of rows as any[]) if (r.totp_secret_id && r.password_secret_id) target = { id: r.id, ws: w.id };
  }
  if (!target) { console.log('no 2fa account'); process.exit(0); }
  const ctx = await sessions.buildLoginContext(target.id, target.ws);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const c = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-IN', timezoneId: 'Asia/Kolkata',
  });
  const page = await c.newPage();
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(2500);

  await page.locator('input[autocomplete="username"], input[type="email"]').filter({ visible: true }).first().fill(ctx!.email);
  await page.locator('input[type="password"]').filter({ visible: true }).first().fill(ctx!.password);
  await page.getByRole('button', { name: /^Sign in$/ }).first().click();
  await page.waitForTimeout(6000);

  console.log('AFTER-SIGNIN URL:', page.url());
  const txt = (await page.locator('body').innerText().catch(() => '')).slice(0, 600);
  console.log('AFTER-SIGNIN TEXT:\n', txt.replace(/\n{2,}/g, '\n'));
  console.log('--- error message? ---');
  for (const s of ['.form__label--error', '[role="alert"]', '.alert', 'text=/wrong|incorrect|couldn.t|too many|try again/i']) {
    const n = await page.locator(s).count().catch(() => 0);
    if (n) console.log('  ', s, '=', (await page.locator(s).first().innerText().catch(() => '')).slice(0, 120));
  }
  console.log('--- 2FA/pin inputs present? ---');
  for (const s of ['input[name="pin"]', '#input__phone_verification_pin', 'input[autocomplete="one-time-code"]', 'input[type="tel"]', 'input[name="verificationCode"]']) {
    console.log('  ', await page.locator(s).count(), s);
  }
  const cookies = await c.cookies('https://www.linkedin.com');
  console.log('li_at present:', cookies.some((x) => x.name === 'li_at'));
  await page.screenshot({ path: SHOT });
  console.log('screenshot:', SHOT);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
