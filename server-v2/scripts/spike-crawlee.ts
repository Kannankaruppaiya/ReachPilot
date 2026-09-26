/**
 * Throwaway spike: can Crawlee's PlaywrightCrawler run patchright past Google's
 * checks, dedupe via RequestQueue, and paginate? Not wired into the app.
 *
 *   npm run spike:crawlee
 */

// In-memory storage (set before Crawlee initialises) so dedup is per run.
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
    // Let patchright own the stealth; no Crawlee fingerprints on top.
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
