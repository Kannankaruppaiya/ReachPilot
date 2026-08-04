/**
 * Multi-engine acceptance (throwaway) — run the REAL LeadScraperService.search()
 * in 'multi' mode end-to-end: rotate Google→Bing→DuckDuckGo→Brave with per-engine
 * block cooldown → Gemini extract → validation gate → leads. Proves that even when
 * Google is CAPTCHA-blocking this IP, the other engines still return leads.
 * Run:  npm run test:multi
 */
process.env.SCRAPER_ENGINE = 'multi';

import { AiService } from '@/modules/ai/ai.service';
import { LeadScraperService } from '@/modules/scraping/lead-scraper.service';

async function main() {
  const scraper = new LeadScraperService(new AiService());
  const t0 = Date.now();
  const leads = await scraper.search({
    titles: ['Juniper trainer', 'Network trainer'],
    location: 'India',
    maxResults: 20,
  });
  console.log(`\n===== MULTI-ENGINE RESULT =====`);
  console.log(`engines=${process.env.SCRAPER_ENGINES || 'google,bing,duckduckgo,brave'}`);
  console.log(`${leads.length} valid leads in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  leads.forEach((l, i) =>
    console.log(
      `${String(i + 1).padStart(2)}. ${l.name} — ${l.title || '?'} @ ${l.company || '?'} · ${l.location || '?'}\n    ${l.linkedinUrl}`,
    ),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
