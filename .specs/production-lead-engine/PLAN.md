# Production-Grade Lead Engine — Plan

**Status:** Proposed · **Owner:** Kannan · **Date:** 2026-07-29
**Scope:** Make ReachPilot's free local lead scraper accurate *and* production-grade on volume, reliability, visibility, and enrichment.
**Decisions locked:** Enrichment = **free pattern-based** (no paid Apollo/Hunter). Free-first stays the guiding constraint.

---

## 1. Where we are today

The free scraper works and produces *accurate individual leads*, but it is a thin single-shot pipeline.

**Flow (current)**

```
UI modal / POST /api/leads/scrape / AI "scrape_leads" tool
      → BullMQ "lead-scrape" queue (returns {queued:true} immediately)
      → Worker fleet #8
          → LeadScraperService.search({titles, location, maxResults})
              → patchright headful Chrome → ONE Google page (num=20)
              → grab <a><h3> + snippet for each linkedin.com/in result
              → AiService.extractProfiles()  (Gemini JSON clean-extract, regex fallback)
              → validateClean()  (person-check, title-relevance, grounding, region, slug dedup)
          → LeadsService.importLeads(ws, "google-scrape:<titles>", rows)  (dedup on import)
```

**Key files**
- `server-v2/src/modules/scraping/lead-scraper.service.ts` — scrape + parse + validate
- `server-v2/src/modules/ai/ai.service.ts` → `extractProfiles()` — batched Gemini clean-extract
- `server-v2/src/modules/scraping/scraping.controller.ts` — `POST /api/leads/scrape` producer
- `server-v2/src/worker.ts` — fleet #8 `lead-scrape` consumer
- `server-v2/src/modules/ai/ai-agent.service.ts` — `scrape_leads` chat tool

**What is genuinely good and must be preserved**
- Hybrid extraction: Gemini clean-extract per URL, regex fallback per missed URL — a partial AI failure never loses leads.
- Anti-false gate (`validateClean`): name normalization, person-vs-company/role rejection, title relevance, **grounding** (a field is kept only if it appears in the source SERP text — anti-hallucination), region sanity, slug-based dedup.
- Reads Google only — **never** touches a LinkedIn account session, so a scrape can't ban an outreach account.

---

## 2. Correctness audit — the real gaps

Accuracy is solved; **coverage, reliability, and visibility are not**. Ranked by impact.

| # | Gap | Root cause | Consequence |
|---|-----|-----------|-------------|
| **G1** | **Low volume** — ~10 leads/run | Single Google page, `num=20`, one query string | To get 100 leads you rerun 10× and fight overlap |
| **G2** | **Reruns return the same leads** | No per-workspace cursor; every run scrapes the same top results | Import dedup drops them → "0 new"; forced Kannan to delete + re-scrape |
| **G3** | **Single engine, no fallback** | Only Google; Bing/Brave were blocked earlier and dropped | A Google CAPTCHA = 0 leads, no recovery |
| **G4** | **No job visibility** | API returns `{queued:true}`; UI just polls `getLeads` | Blocked / 0-found looks identical to "still running"; no reason surfaced |
| **G5** | **No email enrichment** | Only the LinkedIn URL is captured | Leads can't feed email campaigns |
| **G6** | **No relevance ranking** | `validateClean` is binary keep/drop | Best-fit leads don't surface first |
| **G7** | **Home-IP headful only** | `channel:'chrome', headless:false`, no proxy hook, no block-backoff | Can't run on a headless cloud box; repeated runs risk soft-blocking the home IP |

> Note on Google `num`: Google has been ignoring/deprecating the `num` param (notably `num=100`). The plan must **not** rely on `num=20` returning 20 — pagination via `start=` is the durable lever, and the parser must handle whatever count a page returns.

---

## 3. Goals / Non-goals

**Goals**
1. One scrape run yields a **meaningful batch** (target 40–60 unique valid leads) without manual reruns.
2. Reruns keep finding **new** leads until a query space is exhausted.
3. The user always sees **what happened** — running, counts per stage, and *why* a run was thin (blocked / exhausted / off-target).
4. Best-fit leads surface **first** (scored).
5. Each lead carries a **best-effort free email** with a confidence signal.
6. No regression in per-lead accuracy; still zero LinkedIn-account risk.

**Non-goals (this plan)**
- Paid enrichment (Apollo/Hunter/ZoomInfo).
- Paid hosted scraping (Firecrawl/just-scrape) as the *primary* engine — kept only as an optional scale-time fallback.
- Cloud/headless migration — stays PC-hosted; we only add the *hooks* (proxy, backoff) so a later move is cheap.
- Deep per-profile verification via Apify (optional Phase 4, opt-in).

---

## 4. Data-model changes

One migration, additive, RLS-consistent with the existing tenant model.

**`0006_lead_engine.sql`**

New table `scrape_jobs` (drives visibility G4):
| column | type | notes |
|--------|------|-------|
| `id` | uuid pk | |
| `workspace_id` | uuid | RLS `tenant_isolation` (same policy as 0003) |
| `titles` | jsonb | requested titles |
| `location` | text | |
| `max_results` | int | |
| `status` | text | `queued` \| `running` \| `done` \| `blocked` \| `failed` |
| `stage` | text | human line: "expanding queries", "page 3/8", "enriching" |
| `counts` | jsonb | `{raw, candidates, valid, imported, enriched}` |
| `reason` | text | on thin/blocked runs: `captcha_blocked` \| `exhausted` \| `no_results` |
| `created_at` / `updated_at` | timestamptz | |

`leads` — add enrichment columns (G5):
- `email text`
- `email_confidence smallint` (0–100)
- `email_pattern text` (which pattern produced it, e.g. `first.last`)
- `fit_score smallint` (0–100, G6)

> Type upkeep: mirror new tables/columns in **both** `src/db/types.ts` and the hand-maintained `DatabaseSchema` map in `src/db/kysely.ts` (forgetting the latter = TS2769, per prior migrations).

**Redis keys**
- `scrape:cursor:<ws>:<queryHash>` → next `start` offset per expanded query (G2).
- `scrape:cooldown:<ws>` → last-run stamp to space runs on one IP (G7).

---

## 5. Phased design

### Phase 1 — Volume + Visibility  *(the core fix; do first)*

**1a. AI query expansion** — `AiService.expandQueries(titles, location)`
- One Gemini JSON call → title synonyms + location sub-regions.
  - `"Finance Head"` → `Head of Finance`, `Finance Controller`, `VP Finance`, `Finance Director`
  - `"Tamil Nadu"` → `Chennai`, `Coimbatore`, `Madurai`, `Tiruchirappalli`
- Produces an ordered list of `(titleGroup, locationVariant)` query plans. Cap the fan-out (e.g. ≤ 8 query strings/run) to bound runtime and IP exposure.
- Degrades to the single literal query if Gemini is unavailable (same safety pattern as `extractProfiles`).

**1b. Pagination** — inside `LeadScraperService.search`
- For each expanded query, fetch pages via `&start=0,10,20…` until: enough valid leads collected, a page yields no new profile links, or a page-cap is hit.
- Human 1.5–4s jitter between page loads; reuse the one persistent context (don't relaunch per page).

**1c. Per-workspace cursor (G2)**
- Before scraping a query, read `scrape:cursor:<ws>:<queryHash>` and start from that offset; after, advance it by pages consumed.
- Rerun with the same titles → continues into deeper pages instead of re-fetching page 1.
- A "start fresh" flag resets the cursor (for when the user wants to re-sweep).

**1d. Job visibility (G4)**
- Controller creates a `scrape_jobs` row (`queued`) and returns its `id`.
- Worker updates `status`/`stage`/`counts` as it progresses; sets `reason` on thin/blocked runs.
- **Block detection:** if a Google page shows a consent/CAPTCHA/"unusual traffic" interstitial and no results parse, mark `blocked` + `reason:captcha_blocked` and stop (don't hammer).
- New `GET /api/leads/scrape/:id` (and/or `GET /api/leads/scrape/active`) for the UI to poll.
- **Frontend:** the Leads "Scrape leads" modal shows a live status line ("Page 3/8 · 24 found · 18 valid") and a clear terminal state ("Done — 41 leads added" / "Google blocked this run, try again in a few minutes" / "No more new profiles for these titles").

**Acceptance:** one run on a real title+location yields ≥ 40 valid leads; an immediate rerun yields *new* leads (cursor advanced); a simulated block surfaces `captcha_blocked` in the UI rather than silence.

---

### Phase 2 — Relevance scoring (G6)

`LeadScraperService.scoreLead(lead, opts)` → `fit_score` 0–100, computed from signals we already have:
- **Title match** (largest weight): exact requested title > synonym > loose keyword overlap (reuse `titleRelevant` logic, graded not binary).
- **Seniority alignment:** head/director/VP/C-level vs the requested seniority band.
- **Location match:** exact requested region > sub-region > same state > unknown.
- **Field completeness:** company present, location present (a fuller lead is more actionable).

- Store `fit_score`; `validateClean` already removes junk, so scoring only ranks survivors.
- Sort imported leads best-first; optional `minScore` filter in the modal.
- **Frontend:** a small score chip on each lead row (e.g. 82 · good fit). Semantic color, separate from the app accent.

**Acceptance:** for a mixed batch, an exact-title in-region lead outscores a loose-keyword out-of-sub-region lead; sort order reflects it.

---

### Phase 3 — Free email enrichment (G5)  *(free pattern-based, as chosen)*

**Honest framing:** pattern-based email is a *best-effort guess with a confidence score*, not verified truth. Expect ~60–70% hit rate, never 100%. We surface confidence and never present a guess as confirmed.

`EmailEnrichService.enrich(lead)` — best-effort, returns `null` cleanly on any miss:

1. **Company → domain.** Resolve the employer's web domain from the company name using a **free** resolver (Clearbit's public autocomplete endpoint `autocomplete.clearbit.com/v1/companies/suggest?query=<name>` returns a domain with no key; fall back to a Google `site:` lookup through the existing scraper if needed). No domain → no email.
2. **Generate candidates** from `firstName`/`lastName` + domain, in confidence order:
   `first.last@` › `first@` › `f.last@` › `firstlast@` › `flast@` › `last.first@`.
3. **Verify cheaply, safely:**
   - **MX lookup** (Node `dns.resolveMx` on the domain) — confirms the domain accepts mail. Required; no MX → discard.
   - **Optional SMTP RCPT probe** — *design in a hook but default OFF.* SMTP probing from a home IP is unreliable (catch-all domains, greylisting) and can get the IP blacklisted. Treat as opt-in, rate-limited, never on the outreach IP.
4. **Confidence score** = pattern rank + MX present (+ known-pattern-for-domain cache bonus). Store `email`, `email_confidence`, `email_pattern`.
5. **Caching:** cache `company → domain` and `domain → winning pattern` in Redis so a confirmed pattern lifts confidence for later leads at the same company.

- Runs in the worker after `validateClean`, before/at import; best-effort and never blocks the import of a lead that fails to enrich.
- **Frontend:** show email with a confidence indicator (e.g. "likely" vs "guess"); make it easy to exclude low-confidence emails from an email campaign.

**Acceptance:** for leads at companies with a resolvable domain + MX, a plausible email with a confidence ≥ threshold is attached; unresolvable ones import cleanly with no email and no crash.

---

### Phase 4 — Robustness / scale hooks  *(later; design-only now)*

- **Multi-engine fallback:** if Google blocks, try one alternate engine (Bing/Brave/DuckDuckGo-html) through the same stealth context before giving up. Same parse → same validation gate.
- **IP cooldown + backoff (G7):** enforce `scrape:cooldown:<ws>` spacing between runs; exponential backoff after a detected block.
- **Proxy hook:** a `SCRAPER_PROXY_URL` env that, when set, routes the context through a residential proxy — the clean path to headless/cloud and multi-account scale.
- **Optional deep-verify:** for the top-N scored leads only, an opt-in Apify profile scrape to confirm current company/title before outreach (spends credit; user-triggered).

---

## 6. Cross-cutting: reliability & safety invariants

- **Never throw to the caller.** Every new stage (expand, paginate, enrich) degrades to a safe fallback, mirroring `extractProfiles`/`generateConnectionNote`. A scrape must never crash the worker.
- **Zero LinkedIn-account risk preserved.** Still reads search engines only; no linkedin.com session, no cookie use in this path.
- **Idempotent import.** Keep routing through `LeadsService.importLeads` (existing dedup) — new fields ride along on the same rows.
- **Bounded work.** Cap expanded queries and pages per run so runtime and IP exposure stay predictable.
- **Best-effort persistence.** `scrape_jobs` updates are best-effort; a status-write failure never fails the scrape itself.

---

## 7. Rollout & verification

1. Migration `0006` applied (Supabase superuser `DATABASE_URL`); types mirrored in both maps; `tsc --noEmit` clean (server + web).
2. Phase 1 behind no flag (pure improvement); Phase 3 behind `EMAIL_ENRICH_ENABLED` (default on once verified).
3. **Live verification pattern (Kannan's usual):** run a real scrape on a known title+location, watch the worker log + the UI status line, confirm: volume ≥ target, rerun yields new leads, a forced block surfaces cleanly, emails attach with sane confidence.
4. Kill stale worker trees before "restart" testing (Windows TaskStop leaves the node worker alive — verify by `CommandLine` match, per ops notes).
5. Ship: commit → `git push` → `vercel --prod --yes` (frontend), restart API+Worker on the PC.

---

## 8. Open decisions (need Kannan's call before build)

- **Volume target per run** — is 40–60 the right batch size, or higher? (Higher = more pages = more IP exposure/time.)
- **Query fan-out cap** — how aggressive should AI expansion be (more synonyms = more coverage but more off-target risk the gate must catch)?
- **SMTP probe** — leave OFF (safe, MX-only) as planned, or enable it opt-in later?
- **Cursor reset UX** — separate "start fresh" button vs. auto-reset after a query space is exhausted?

---

## 9. Suggested build order

1. **Phase 1** (volume + cursor + visibility) — unblocks the real pain, no schema risk beyond `scrape_jobs`.
2. **Phase 2** (scoring) — small, rides on Phase 1 data.
3. **Phase 3** (free email enrichment) — independent, additive columns.
4. **Phase 4** (robustness hooks) — as scale demands.

*This document is a plan only — no code changes have been made.*
