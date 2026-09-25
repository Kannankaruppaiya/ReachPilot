# 05 — Lead sourcing, enrichment, lists and blacklists

## 1. Market bar

| Capability | Expandi | Waalaxy | La Growth Machine | lemlist / Instantly | Dripify / HeyReach | ReachPilot today |
|---|---|---|---|---|---|---|
| CSV / XLSX import | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (Auto Connect / Auto Mail upload; `POST /api/leads/import`) |
| LinkedIn search URL import | ✅ | ✅ | ✅ | via extension | ✅ | ❌ — onboarding asks for the URL and ignores it |
| Sales Navigator lists/search | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Post likers / commenters, events, groups | ✅ (9 lead sources) | ✅ | ✅ (intent data) | intent signals | Dripify: any post | ❌ |
| Built-in contact database | ❌ | ❌ | 27M companies | 450–600M contacts | ❌ | ❌ |
| Email finder / enrichment | ❌ | ✅ cascade: BetterContact → FullEnrich → DropContact | ✅ waterfall: 9 providers + 2 verifiers | ✅ | 100 credits / seat | ❌ |
| Email verification | — | ✅ | ✅ | ✅ | ✅ | ❌ (`email_verified` is set true for anything containing "@") |
| Lead lists / tags | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 tags column; bulk "Tag" button only shows a toast (`src/screens/Leads.tsx:712`) |
| Blacklist: person, email, company domain | ✅ (person + company) | ✅ | ✅ | ✅ | ✅ | 🟡 `blacklist` table exists; Settings → Blacklist is a fake form (`src/screens/Misc.tsx:741–743`) |
| Google/web search → LinkedIn profiles | — | — | — | — | — | ✅ unique: headful Google SERP scraper (`modules/scraping/*`, optional VPS microservice `src/scraper-service.ts`) |
| AI research / ICP scoring | — | Waalaxy AI | lookalikes | Instantly Copilot | — | 🟡 `fit_score` column; AI note uses Apify profile scrape |

## 2. Legal and platform risk — decide this first

- LinkedIn prohibits scraping in its User Agreement and **sues data scrapers**:
  Proxycurl (shut down, July 2025), ProAPIs (consent judgment banning it from
  LinkedIn, Sept 2026). It removed Apollo.io's and Seamless.ai's company pages
  over their extensions (2025).
- The lawsuits targeted **industrial scraping with fake accounts** and resale of
  data. What sequencers do — a customer importing a search they ran, from their
  own account, at human pace — risks the customer's *account*, not a lawsuit
  against the vendor. Keep ReachPilot on that side:
  1. Import only through the customer's own session via the desktop agent.
  2. Low, paced volumes (e.g. ≤ 5 result pages ≈ 50–100 profiles per account per
     day), counted against a separate "browse" budget and never while a send is
     running.
  3. Store only what outreach needs (name, headline/title, company, location,
     profile URL); never resell or pool data across workspaces.
- **Google SERP scraping** (current scraper) violates Google's terms and
  CAPTCHAs are the main failure mode (the code already rotates engines for that
  reason — `scraping/engine/multi-engine-fetcher.ts`). For a sellable feature, move
  to a paid SERP API (SerpApi / Serper / Brave Search API) behind the same
  `LeadScraperService` interface; keep the patchright scraper only as a fallback.
- **Privacy law** applies to prospect data (doc 11): GDPR Art. 14 (tell a
  prospect where you got their data within a month when you contact them),
  opt-out honoured everywhere, and India's DPDP Act (operative rules from
  13 May 2027; the Act excludes personal data the person *themselves made
  publicly available* — get legal advice on how far that stretches).

## 3. Gaps and how to close them

### L1 (P0) — Every send path creates leads (one source of truth)
**Today:** Auto Connect and Auto Mail send from an uploaded sheet and never
create `leads` rows or set `jobs.lead_id` (`src/screens/AutoSend.tsx:240` sends no
`leadId`). Consequences: blacklist/suppression does not apply to them, replies to
Auto Mail are never detected (Gmail sync matches leads by email), and acceptance
cannot be recorded (doc 03).
**Build:** in `JobsService.createBatch`, call `LeadsService.importLeads` for the
rows first (same transaction), then set `lead_id` on every job. Skip rows whose
lead is `blacklisted`/`unqualified` or matches the blacklist table (L4).

### L2 (P0) — Make onboarding's lead step real (or remove it)
**Today:** the "LinkedIn search" / "Sales Navigator" options send a URL that the
server ignores, and "CSV" imports a placeholder row that is skipped
(`src/screens/AuthOnboarding.tsx` ~lines 729–747,
`onboarding.controller.ts` `importLeads`).
**Build now:** CSV → real file picker using the same XLSX parser as Auto Send;
Search/Sales Nav → store the URL as a *pending import* (L3) and tell the user it
runs when the desktop app is online. Until L3 exists, hide those two options.

### L3 (P1) — Import from LinkedIn search / Sales Navigator via the desktop agent
1. New agent action `import_search` with `{ url, maxPages }`; the bundled driver
   opens the user's search URL, reads result cards page by page with the normal
   spacing gap, and returns `{ name, headline, company, location, profileUrl }[]`.
2. Server stores results through `LeadsService.importLeads` with a `scrape_jobs`
   row for progress (the table and the Leads screen progress UI already exist —
   `modules/scraping/scrape-jobs.service.ts`).
3. Budget: separate daily page budget; never runs in parallel with sends.
4. Sales Navigator: same action with Sales Navigator selectors (only for senders
   with a Sales Navigator seat).
5. Validate selectors on a throwaway account first (CLAUDE.md).

### L4 (P0) — Real blacklist (person, email, company domain)
1. API: `GET/POST/DELETE /api/blacklist` over the existing `blacklist` table
   (`kind` ∈ `linkedin_url`, `email`, `company_domain`).
2. Settings → Blacklist: replace the fake textarea with the real list; bulk paste;
   CSV import.
3. Enforce in three places: `createBatch` (skip), campaign `enroll` (skip), and
   the **scheduler suppression gate** (cancel with `suppressed:blacklist`) — match
   on profile key, email, and the email/website domain.
4. Auto-add on: unsubscribe reply, "not interested" classification (doc 03 §4),
   hard bounce (doc 06).

### L5 (P1) — Lists, tags and lead management
- Bulk tag/untag endpoint (`PATCH /api/leads/bulk`) and wire the Leads bar's Tag
  button; saved lists (a tag is enough to start).
- Delete leads (single + bulk) with cascade to enrollments; merge duplicates.
- Custom fields from extra CSV columns in `leads.enrichment` (used as
  `{{custom.*}}` variables — doc 04 S7).
- Company records (name, domain, size) for company-level dedupe and blacklist.

### L6 (P1) — Email finder + verification (waterfall)
1. Interface `EmailFinder` with providers tried in order (e.g. a
   "found-only billing" provider first, then a second), stop at the first result
   with confidence ≥ threshold. Waalaxy and LGM both use this waterfall pattern.
2. Verify every address with a verification API before any send; store
   `email`, `email_confidence`, `email_verified`, `email_pattern` (columns already
   exist since migration 0006).
3. **Credits:** charge only when an email is found (Waalaxy refunds unfound);
   meter per workspace (doc 10).
4. Never verify by SMTP-probing from our own servers (it burns IP reputation).
5. Sequence step `enrich` (enum value exists) so a campaign can find an email
   only for leads who did not accept on LinkedIn.

### L7 (P2) — Signal-based sources
Profile viewers (needs Premium on the sender), your own post's likers/commenters,
a competitor's post engagers, event attendees, group members — each as an agent
import action with small daily budgets. This is where Expandi, Waalaxy and Valley
are moving; it pairs with AI scoring (L8).

### L8 (P2) — AI ICP scoring
Score each lead 0–100 against a written ICP with Gemini
(`modules/ai/ai.service.ts`) into `leads.fit_score`; sort and filter by it
(the Leads screen already supports `sort=score`).

## 4. Acceptance tests
- `createBatch` with a blacklisted domain skips the row and reports it in
  `skipped`; every created job has a `lead_id`.
- Blacklist entry added mid-campaign → the next scheduler drain cancels the
  lead's pending job with `suppressed:blacklist`.
- Email waterfall stops at the first confident provider and records the source.

## Sources
- Waalaxy cascading email finder: https://intercom.help/waalaxy/en/articles/5478383-how-does-the-find-email-work
- La Growth Machine waterfall enrichment: https://lagrowthmachine.com/pricing/
- Expandi lead sources: https://expandi.io/lead-generation/
- LinkedIn enforcement: https://news.bloomberglaw.com/artificial-intelligence/startup-banned-from-using-linkedin-data-in-scraping-lawsuit · https://www.leadgenius.com/resources/linkedins-crackdown-on-data-scrapers-why-apollo-io-and-seamless-ai-were-targeted--and-whos-next
- India DPDP Rules timeline: https://lexcounsel.in/newsletters/regulatory-update-notification-of-the-digital-personal-data-protection-rules-2025/
