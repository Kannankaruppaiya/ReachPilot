/**
 * Local finance-lead pull → Excel.
 *
 * Runs the free local scraper (public SERPs only — never linkedin.com directly)
 * for finance decision-makers in Tamil Nadu, India, sweeps pages with the cursor
 * until the target count is reached, and writes an .xlsx you can open in Excel.
 *
 *   npm run export:finance            # 100 leads, Tamil Nadu
 *   TARGET=50 LOCATION="Chennai" npm run export:finance
 *
 * No DB / Redis / worker needed — this only touches the scraper + Gemini extract.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { AiService } from '@/modules/ai/ai.service';
import { LeadScraperService, ScrapedLead } from '@/modules/scraping/lead-scraper.service';

const TARGET = Math.min(Number(process.env.TARGET) || 100, 500);
const LOCATION = process.env.LOCATION || 'Tamil Nadu';
const TITLES = (process.env.TITLES ||
  'Finance Head,Finance Manager,Head of Finance,Finance Controller,CFO,Accounts Manager')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)
  .slice(0, 6);

/** Public "activity" proxy: LinkedIn SERP snippets carry follower/connection counts. */
function activityOf(snippet: string): { followers: number; connections: string } {
  const f = snippet.match(/([\d,.]+)\s*(K|M)?\s*followers/i);
  let followers = 0;
  if (f) {
    followers = parseFloat(f[1].replace(/,/g, '')) || 0;
    if (/k/i.test(f[2] || '')) followers *= 1_000;
    if (/m/i.test(f[2] || '')) followers *= 1_000_000;
  }
  const c = snippet.match(/(\d[\d,+]*)\s*connections/i);
  return { followers: Math.round(followers), connections: c ? c[1] : '' };
}

const slug = (u: string) => (u.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] || '').toLowerCase();

async function main() {
  const scraper = new LeadScraperService(new AiService());
  const bySlug = new Map<string, ScrapedLead>();
  const t0 = Date.now();

  console.log(`\n▶ titles   : ${TITLES.join(' | ')}`);
  console.log(`▶ location : ${LOCATION}, India`);
  console.log(`▶ target   : ${TARGET} unique profiles\n`);

  // Cursor sweep: each round advances the SERP page window so a rerun sees NEW
  // results instead of re-reading page 1. Stop on target, page exhaustion, or
  // two consecutive empty rounds (every engine blocked / results ran out).
  let startPage = 0;
  let emptyRounds = 0;
  for (let round = 1; round <= 12 && bySlug.size < TARGET && emptyRounds < 2; round++) {
    const before = bySlug.size;
    const leads = await scraper.search({
      titles: TITLES,
      location: LOCATION,
      maxResults: Math.min(TARGET - bySlug.size + 20, 100),
      startPage,
      pages: 4,
    });
    for (const l of leads) {
      const s = slug(l.linkedinUrl);
      if (s && !bySlug.has(s)) bySlug.set(s, l);
    }
    const gained = bySlug.size - before;
    console.log(`  round ${round} (pages ${startPage}..${startPage + 3}): +${gained} new → ${bySlug.size}/${TARGET}`);
    emptyRounds = gained === 0 ? emptyRounds + 1 : 0;
    startPage += 4;
  }

  const rows = [...bySlug.values()]
    .map((l) => {
      const act = activityOf(l.snippet || '');
      return {
        Name: l.name,
        'First Name': l.firstName,
        Title: l.title,
        Company: l.company,
        Location: l.location || LOCATION,
        Country: 'India',
        'LinkedIn URL': l.linkedinUrl,
        Followers: act.followers || '',
        Connections: act.connections,
        'Activity Signal': act.followers >= 5000 ? 'high' : act.followers >= 500 ? 'medium' : 'unknown',
        Snippet: l.snippet,
      };
    })
    // Most-visible profiles first — the closest public proxy for "active".
    .sort((a, b) => (Number(b.Followers) || 0) - (Number(a.Followers) || 0))
    .slice(0, TARGET);

  const outDir = path.join(__dirname, '..', 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `finance-leads-${LOCATION.toLowerCase().replace(/\s+/g, '-')}-${stamp}`;
  const xlsxPath = path.join(outDir, `${base}.xlsx`);
  const csvPath = path.join(outDir, `${base}.csv`);

  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet['!cols'] = [22, 12, 30, 28, 24, 10, 46, 10, 12, 14, 60].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Finance Leads');
  XLSX.writeFile(wb, xlsxPath);
  // BOM'd CSV too — same shape as the app's Leads → Export button.
  fs.writeFileSync(csvPath, '﻿' + XLSX.utils.sheet_to_csv(sheet), 'utf8');

  console.log(`\n===== EXPORT DONE (${((Date.now() - t0) / 1000).toFixed(0)}s) =====`);
  console.log(`  ${rows.length} unique leads`);
  console.log(`  xlsx → ${xlsxPath}`);
  console.log(`  csv  → ${csvPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('EXPORT ERROR:', e);
  process.exit(1);
});
