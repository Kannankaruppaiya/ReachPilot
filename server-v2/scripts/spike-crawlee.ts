/**
 * M0 SPIKE (throwaway) — de-risk the Crawlee re-architecture bet.
 *
 * Proves three things before we build anything real:
 *   1. Crawlee's PlaywrightCrawler can use the **patchright** stealth launcher and
 *      still pass Google's bot checks (no CAPTCHA on the home IP).
 *   2. RequestQueue gives dedup for free (re-adding a URL is caught).
 *   3. Pagination works (seed pages start=0/10/20, each parsed).
 *
 * Not wired into the app. Run:  npm run spike:crawlee
 * GO  → build M1 (engine swap).   NO-GO → fall back to hand-built frontier.
 */

// In-memory Crawlee storage so the spike leaves no disk state and dedup is
// measured within this run only. Must be set before Crawlee initializes.
process.env.CRAWLEE_PERSIST_STORAGE = '0';
process.env.CRAWLEE_PURGE_ON_START = '1';

import { PlaywrightCrawler, RequestQueue } from 'crawlee';
import { chromium } from 'patchright';

const QUERY = '("Finance Manager" OR "Finance Head") "Tamil Nadu" site:linkedin.com/in';
const PAGES = 3;

function googleUrl(q: string, page: number): string {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&hl=en&gl=in&start=${page * 10}`;
}

async function main() {
  const queue = await RequestQueue.open();
  const seedUrls = Array.from({ length: PAGES }, (_, i) => googleUrl(QUERY, i));
  for (const url of seedUrls) await queue.addRequest({ url });

  // Prove dedup: re-add the same seeds and count how many were already present.
  let dupHits = 0;
  for (const url of seedUrls) {
    const r = await queue.addRequest({ url });
    if (r.wasAlreadyPresent) dupHits++;
  }
  console.log(`DEDUP CHECK: re-added ${seedUrls.length} seeds → ${dupHits} already present (expect ${seedUrls.length}).`);

  const profiles = new Set<string>();
  let blocked = false;
  let pagesOk = 0;

  const crawler = new PlaywrightCrawler({
    requestQueue: queue,
    // Swap Crawlee's default playwright for the patchright stealth fork.
    launchContext: {
      launcher: chromium as any,
      launchOptions: { headless: false, channel: 'chrome' } as any,
    },
    // Let patchright own the stealth — don't layer Crawlee's own fingerprints on top.
    browserPoolOptions: { useFingerprints: false },
    maxConcurrency: 1,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 90,
    async requestHandler({ page, request, log }) {
      await page.waitForTimeout(3000);

      // Consent wall.
      try {
        const btn = page.getByRole('button', { name: /^(Accept all|I agree|Accept|Agree)$/i }).first();
        if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await btn.click().catch(() => undefined);
          await page.waitForTimeout(1500);
        }
      } catch {
        /* no consent wall */
      }

      const title = await page.title();
      if (/unusual traffic|not a robot|captcha/i.test(title) || page.url().includes('/sorry/')) {
        blocked = true;
        log.warning(`BLOCKED on ${request.url} (title: "${title}")`);
        return;
      }

      const links: string[] = await page
        .evaluate(() => {
          const out: string[] = [];
          document.querySelectorAll('a').forEach((a) => {
            const href = (a as HTMLAnchorElement).href || '';
            if (/linkedin\.com\/in\//i.test(href) && a.querySelector('h3')) out.push(href);
          });
          return out;
        })
        .catch(() => [] as string[]);

      links.forEach((l) => profiles.add(l));
      pagesOk++;
      const start = request.url.match(/start=(\d+)/)?.[1] ?? '0';
      log.info(`page start=${start} OK → ${links.length} profile links (unique total ${profiles.size})`);
    },
    failedRequestHandler({ request, log }) {
      log.error(`FAILED: ${request.url}`);
    },
  });

  await crawler.run();

  console.log('\n===== M0 SPIKE RESULT =====');
  console.log(`Stealth / Google : ${blocked ? 'BLOCKED ❌' : profiles.size > 0 ? 'PASSED ✅' : 'NO RESULTS ⚠️'}`);
  console.log(`Pages parsed OK  : ${pagesOk}/${PAGES}`);
  console.log(`Unique profiles  : ${profiles.size}`);
  console.log(`Dedup caught     : ${dupHits}/${seedUrls.length} repeat seeds`);
  console.log('===========================');
  [...profiles].slice(0, 12).forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error('SPIKE ERROR:', e);
  process.exit(1);
});
