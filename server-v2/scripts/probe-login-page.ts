import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const page = await ctx.newPage();
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(4000);

  console.log('URL:', page.url());
  console.log('TITLE:', await page.title());

  const selectors = [
    '#username',
    'input[name="session_key"]',
    'input[autocomplete="username"]',
    'input[type="email"]',
    '#password',
    'input[name="session_password"]',
    'button[type="submit"]',
    'text=/Sign in/i',
    'text=/Agree|Accept|cookie/i',
  ];
  for (const s of selectors) {
    const n = await page.locator(s).count().catch(() => -1);
    console.log(`  ${n > 0 ? 'FOUND' : '  no '} (${n})  ${s}`);
  }

  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
  console.log('\nBODY TEXT (first 400):\n', bodyText.replace(/\n{2,}/g, '\n'));

  await page.screenshot({ path: 'C:/Users/Kannan/AppData/Local/Temp/claude/li-login.png', fullPage: false });
  console.log('\nscreenshot saved');
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error('PROBE ERROR:', e.message);
  process.exit(1);
});
