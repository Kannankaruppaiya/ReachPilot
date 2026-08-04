/**
 * M2 acceptance (throwaway) — proves the rerun cursor gives FRESH leads.
 * Mimics exactly what worker fleet #8 does: read cursor → search that page window
 * → advance cursor. Two runs of the SAME search must return DIFFERENT leads.
 * Needs Redis. Run:  npm run test:m2
 */
process.env.SCRAPER_ENGINE = 'crawlee';

import { AiService } from '@/modules/ai/ai.service';
import { LeadScraperService } from '@/modules/scraping/lead-scraper.service';
import { ScrapeCursorService } from '@/modules/scraping/scrape-cursor.service';

async function run(scraper: LeadScraperService, cursor: ScrapeCursorService, ws: string, titles: string[], location: string) {
  const qk = cursor.queryKey(titles, location);
  const startPage = await cursor.nextPage(ws, qk);
  const leads = await scraper.search({ titles, location, maxResults: 20, startPage, pages: 2 });
  if (leads.length) await cursor.advance(ws, qk, 2);
  return { startPage, leads };
}

async function main() {
  const scraper = new LeadScraperService(new AiService());
  const cursor = new ScrapeCursorService();
  const ws = 'test-ws-m2';
  const titles = ['Finance Manager'];
  const location = 'Tamil Nadu';
  await cursor.reset(ws, cursor.queryKey(titles, location));

  console.log('RUN 1...');
  const r1 = await run(scraper, cursor, ws, titles, location);
  console.log('RUN 2 (same search — must be fresh)...');
  const r2 = await run(scraper, cursor, ws, titles, location);
  const next = await cursor.nextPage(ws, cursor.queryKey(titles, location));

  const urlsA = new Set(r1.leads.map((l) => l.linkedinUrl));
  const urlsB = new Set(r2.leads.map((l) => l.linkedinUrl));
  const overlap = [...urlsB].filter((u) => urlsA.has(u));

  console.log('\n===== M2 CURSOR RESULT =====');
  console.log(`Cursor: run1 startPage=${r1.startPage}, run2 startPage=${r2.startPage}, next=${next} (expect 0, 2, 4)`);
  console.log(`Run 1: ${r1.leads.length} leads | Run 2: ${r2.leads.length} leads`);
  console.log(`Overlap: ${overlap.length} (expect ~0 = fresh leads on rerun)`);
  console.log(`Run 1 sample: ${[...urlsA].slice(0, 3).join('  ')}`);
  console.log(`Run 2 sample: ${[...urlsB].slice(0, 3).join('  ')}`);
  console.log(overlap.length === 0 ? '\nRERUN FRESH ✅ — cursor works' : `\nSOME REPEAT (${overlap.length}) ⚠️`);
  console.log('============================');
  process.exit(0);
}

main().catch((e) => {
  console.error('M2 TEST ERROR:', e);
  process.exit(1);
});
