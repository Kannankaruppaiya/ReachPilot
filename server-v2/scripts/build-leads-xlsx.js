/**
 * Build the leads .xlsx (+ BOM'd .csv) from exports/_leads.tsv (no header:
 * first, last, title, company, location, linkedinSlug, premium, relevance).
 *
 *   node scripts/build-leads-xlsx.js
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const root = path.join(__dirname, '..');
const rows = fs
  .readFileSync(path.join(root, 'exports', '_leads.tsv'), 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => l.split('\t'));

const RELEVANCE_RANK = { high: 0, medium: 1, low: 2 };

/** Pull the Indian state out of a LinkedIn location string. */
function stateOf(loc) {
  if (/tamil nadu/i.test(loc)) return 'Tamil Nadu';
  if (/chennai|coimbatore|madurai|tiruppur|vellore|thoothukudi/i.test(loc)) return 'Tamil Nadu';
  const m = loc.match(/^([A-Za-z ]+),\s*India$/);
  return m ? m[1].trim() : loc === 'India' ? 'Unspecified' : loc;
}

const seen = new Set();
const leads = [];
for (const [first, last, title, company, location, slug, premium, relevance] of rows) {
  if (seen.has(slug)) continue; // same profile can surface on two search pages
  seen.add(slug);
  const state = stateOf(location);
  leads.push({
    Name: `${first} ${last}`.replace(/\s+/g, ' ').trim(),
    'First Name': first,
    'Last Name': last,
    Title: title,
    Company: company,
    Location: location,
    State: state,
    Country: 'India',
    'LinkedIn URL': `https://www.linkedin.com/in/${slug}`,
    'LinkedIn Premium': premium === 'yes' ? 'Yes' : 'No',
    'Finance Relevance': relevance,
    'Posted in Last 30 Days': 'Yes',
    'In Tamil Nadu': state === 'Tamil Nadu' ? 'Yes' : 'No',
  });
}

// Tamil Nadu first, then finance match, then premium.
leads.sort(
  (a, b) =>
    (a['In Tamil Nadu'] === 'Yes' ? 0 : 1) - (b['In Tamil Nadu'] === 'Yes' ? 0 : 1) ||
    RELEVANCE_RANK[a['Finance Relevance']] - RELEVANCE_RANK[b['Finance Relevance']] ||
    (a['LinkedIn Premium'] === 'Yes' ? 0 : 1) - (b['LinkedIn Premium'] === 'Yes' ? 0 : 1) ||
    a.Name.localeCompare(b.Name),
);
leads.forEach((l, i) => (l['#'] = i + 1));

const ordered = leads.map((l) => ({
  '#': l['#'],
  Name: l.Name,
  'First Name': l['First Name'],
  'Last Name': l['Last Name'],
  Title: l.Title,
  Company: l.Company,
  Location: l.Location,
  State: l.State,
  Country: l.Country,
  'LinkedIn URL': l['LinkedIn URL'],
  'LinkedIn Premium': l['LinkedIn Premium'],
  'Finance Relevance': l['Finance Relevance'],
  'Posted in Last 30 Days': l['Posted in Last 30 Days'],
  'In Tamil Nadu': l['In Tamil Nadu'],
}));

const sheet = XLSX.utils.json_to_sheet(ordered);
sheet['!cols'] = [5, 26, 16, 20, 46, 38, 28, 14, 9, 62, 16, 17, 21, 14].map((wch) => ({ wch }));
sheet['!autofilter'] = { ref: XLSX.utils.encode_range(XLSX.utils.decode_range(sheet['!ref'])) };
sheet['!freeze'] = { xSplit: 0, ySplit: 1 };

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheet, 'Finance Leads TN');

const stamp = new Date().toISOString().slice(0, 10);
const base = path.join(root, 'exports', `finance-leads-tamilnadu-${stamp}`);
XLSX.writeFile(wb, `${base}.xlsx`);
fs.writeFileSync(`${base}.csv`, '﻿' + XLSX.utils.sheet_to_csv(sheet), 'utf8');

const tn = ordered.filter((r) => r['In Tamil Nadu'] === 'Yes').length;
const byRel = ordered.reduce((a, r) => ((a[r['Finance Relevance']] = (a[r['Finance Relevance']] || 0) + 1), a), {});
console.log(`${ordered.length} unique leads  (Tamil Nadu ${tn}, other ${ordered.length - tn})`);
console.log(`relevance: high ${byRel.high || 0} / medium ${byRel.medium || 0} / low ${byRel.low || 0}`);
console.log(`xlsx -> ${base}.xlsx`);
console.log(`csv  -> ${base}.csv`);
