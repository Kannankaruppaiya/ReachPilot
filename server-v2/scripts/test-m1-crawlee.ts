/**
 * M1 acceptance (throwaway) — run the REAL LeadScraperService.search() in crawlee
 * mode end-to-end: Crawlee fetch → Gemini extract → validation gate → leads.
 * Run:  SCRAPER_ENGINE=crawlee npm run test:m1
 */
process.env.SCRAPER_ENGINE = process.env.SCRAPER_ENGINE || 'crawlee';

import { AiService } from '@/modules/ai/ai.service';
import { LeadScraperService } from '@/modules/scraping/lead-scraper.service';

async function main() {
  const scraper = new LeadScraperService(new AiService());
  const t0 = Date.now();
  const leads = await scraper.search({
    titles: ['Finance Manager', 'Finance Head'],
    location: 'Tamil Nadu',
    maxResults: 20,
  });
  console.log(`\n===== M1 RESULT (engine=${process.env.SCRAPER_ENGINE}) =====`);
  console.log(`${leads.length} valid leads in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  leads.forEach((l, i) =>
    console.log(`${String(i + 1).padStart(2)}. ${l.name} — ${l.title || '?'} @ ${l.company || '?'} · ${l.location || '?'}\n    ${l.linkedinUrl}`),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('M1 TEST ERROR:', e);
  process.exit(1);
});
