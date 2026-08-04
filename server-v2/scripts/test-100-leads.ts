/**
 * Volume test (throwaway) — can one run pull ~100 leads? Requests 100 (→ 10 pages)
 * and reports valid + unique yield. Run:  SCRAPER_ENGINE=crawlee npm run test:100
 */
process.env.SCRAPER_ENGINE = 'crawlee';

import { AiService } from '@/modules/ai/ai.service';
import { LeadScraperService } from '@/modules/scraping/lead-scraper.service';

async function main() {
  const scraper = new LeadScraperService(new AiService());
  const t0 = Date.now();
  const leads = await scraper.search({
    titles: ['Finance Manager', 'Finance Head', 'Accounts Manager'],
    location: 'Tamil Nadu',
    maxResults: 100,
  });
  const uniq = new Set(leads.map((l) => l.linkedinUrl));
  console.log('\n===== 100-LEAD VOLUME TEST =====');
  console.log(`Requested 100 → got ${leads.length} valid (${uniq.size} unique) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('================================');
  process.exit(0);
}

main().catch((e) => {
  console.error('TEST ERROR:', e);
  process.exit(1);
});
