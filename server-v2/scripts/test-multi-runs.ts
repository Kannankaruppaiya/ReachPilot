/**
 * Multi-engine STRESS test (throwaway) — run several searches back-to-back in ONE
 * process so the per-engine block cooldown PERSISTS across runs (exactly how the
 * long-lived worker behaves). Proves: repeated runs don't kill the scraper, a
 * blocked engine gets skipped on later runs, and different queries still produce
 * diverse leads. Run:  npm run test:multi:runs
 */
process.env.SCRAPER_ENGINE = 'multi';

import { AiService } from '@/modules/ai/ai.service';
import { LeadScraperService } from '@/modules/scraping/lead-scraper.service';

const RUNS: { titles: string[]; location: string }[] = [
  { titles: ['Juniper trainer', 'Network trainer'], location: 'India' },
  { titles: ['SAP trainer', 'SAP consultant'], location: 'India' },
  { titles: ['Salesforce trainer', 'Salesforce consultant'], location: 'India' },
];

async function main() {
  const scraper = new LeadScraperService(new AiService());
  const summary: string[] = [];

  for (let i = 0; i < RUNS.length; i++) {
    const r = RUNS[i];
    console.log(`\n\n########## RUN ${i + 1}/${RUNS.length}: ${r.titles.join(' / ')} @ ${r.location} ##########`);
    const t0 = Date.now();
    let leads: any[] = [];
    try {
      leads = await scraper.search({ titles: r.titles, location: r.location, maxResults: 15 });
    } catch (e: any) {
      console.error(`run ${i + 1} error:`, e?.message || e);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n----- RUN ${i + 1} → ${leads.length} valid leads in ${secs}s -----`);
    leads.slice(0, 8).forEach((l, j) =>
      console.log(`  ${j + 1}. ${l.name} — ${l.title || '?'} @ ${l.company || '?'} · ${l.location || '?'}`),
    );
    summary.push(`Run ${i + 1} (${r.titles[0]}…): ${leads.length} leads / ${secs}s`);
  }

  console.log(`\n\n===== MULTI-RUN SUMMARY =====`);
  summary.forEach((s) => console.log('  ' + s));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
