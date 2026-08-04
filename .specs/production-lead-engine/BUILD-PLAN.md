# Lead Engine — Full Build Plan (Crawlee re-architecture)

**Status:** Proposed · **Owner:** Kannan · **Date:** 2026-07-31
**Supersedes the engine sections of** `PLAN.md` — same goals, but the engine is now built on **Crawlee (PlaywrightCrawler + patchright launcher)** instead of a hand-rolled crawler.
**Locked decisions:** free-first · free pattern-based email · Node/TS (no Python service) · own-IP proxies (phone/Tailscale) over paid residential where possible.

---

## 0. Principles

1. **Spike before commit.** The whole plan rests on one bet (Crawlee + patchright + stealth passes Google). Prove it in M0 before building anything real. Go/no-go gate.
2. **Every milestone ships independently and is backward-compatible.** A feature flag (`SCRAPER_ENGINE=crawlee|legacy`) keeps the current scraper working until Crawlee is proven; the worker/service contract (`search()` → `ScrapedLead[]`) never breaks.
3. **Don't hand-build what Crawlee gives free** — RequestQueue (dedup + frontier), AutoscaledPool (concurrency), SessionPool (proxy/fingerprint rotation + auto-retire on block), BrowserPool (lifecycle), retry/backoff. We write only domain logic.
4. **Types enforce the flow:** `QueryPlan → SerpRequest → RawResult → Candidate → ValidatedLead → RankedLead → ImportedLead`. Each stage is a small, testable unit.
5. **No LinkedIn-account risk, ever.** This path reads search engines only.

---

## 1. Target architecture

```
QueryPlanner ──seed──► RequestQueue ──► Crawlee engine ──► requestHandler ──► ItemPipeline ──► leads table
(titles×locations)     (persistent,      (AutoscaledPool +   (parse SERP +      (validate → rank
                        auto-dedup,        SessionPool +       Gemini extract)     → enrich → import)
                        cursor/frontier)   BrowserPool +
                                           patchright stealth)
```

**Folder (`server-v2/src/modules/scraping/`)**
```
engine/
  crawlee-engine.ts        # PlaywrightCrawler wiring: queue, pool, sessions, patchright launcher
  query-planner.ts         # expand titles×locations → QueryPlan[] → SerpRequest[]
  search-engine.port.ts    # interface: GoogleAdapter (M1), BingAdapter (M4)
  serp-parser.ts           # DOM → RawResult[] (per-engine selectors)
pipeline/
  extractor.ts             # Gemini + regex fuse → Candidate  (wraps existing extractProfiles)
  validators.ts            # ValidationRule[] chain (person/title/grounding/region) — from validateClean
  ranker.ts                # Candidate → fit_score
  email-enrich.ts          # free pattern-based email (M3)
  importer.ts              # dedup + persist (wraps LeadsService.importLeads)
lead-scraper.service.ts    # KEEPS its public search() contract; delegates to engine when SCRAPER_ENGINE=crawlee
scrape-jobs.service.ts     # job state + counts + reason (M2)
```

**Key interfaces**
```ts
interface SearchEngine { name: string; buildUrl(q: string, page: number): string; parse(page: Page): Promise<RawResult[]>; isBlocked(page: Page): Promise<boolean>; }
interface ValidationRule { name: string; check(c: Candidate, ctx: SearchOptions): boolean; }
interface PipelineStage<In, Out> { run(items: In[], ctx: RunCtx): Promise<Out[]>; }
```

---

## 2. Milestones

### M0 — Spike (de-risk) · ~0.5 day
**Why:** the plan is worthless if patchright doesn't plug into Crawlee's `launchContext.launcher` and pass Google.
**Scope:** a throwaway `scripts/spike-crawlee.ts` — PlaywrightCrawler with patchright chromium, one Google `site:linkedin.com/in` query, RequestQueue seeded with 3 pages, confirm: (a) stealth passes (no CAPTCHA on home IP), (b) RequestQueue dedups repeat URLs, (c) pagination pulls pages 0/1/2.
**Acceptance:** real profiles parsed from ≥2 pages; a re-seed of the same query enqueues 0 new (dedup proven).
**Ship gate:** GO → M1. NO-GO → fall back to hand-built frontier over the existing patchright code (PLAN.md path).

### M1 — Engine swap behind the existing contract · ~2 days
**Why:** get Crawlee running for real without touching the worker/service or UI.
**Scope:**
- `crawlee-engine.ts`: PlaywrightCrawler(patchright launcher, persistent stealth profile, BrowserPool, SessionPool, AutoscaledPool concurrency=1–2).
- `query-planner.ts` (basic: literal query only for now), `GoogleAdapter` + `serp-parser.ts` (move the current SERP selectors here).
- `requestHandler`: parse → `extractor.ts` (reuse `AiService.extractProfiles` + regex fuse) → `validators.ts` (reuse `validateClean` rules) → collect.
- Block detection → `session.retire()` → Crawlee auto-retries on a new session.
- `LeadScraperService.search()`: if `SCRAPER_ENGINE=crawlee` delegate to the engine, else the current path. **Same return type.**
**Acceptance:** `SCRAPER_ENGINE=crawlee` produces leads equal-or-better than legacy on the same query; `tsc` clean; worker + scraper-service unchanged still work.
**Ship gate:** parity with legacy on a real query.

### M2 — Volume + rerun correctness (**the stated pain**) · ~2 days
**Why:** "I need 100, and a rerun must give *new* 100, not repeats." Today: single page ~10, rerun repeats → 0 new.
**Scope:**
- **Pagination:** QueryPlanner seeds pages `0..N`; engine keeps pulling until `maxResults` valid leads collected or the query space is exhausted.
- **Query expansion:** `expandQueries()` (one Gemini call) → title synonyms + sub-locations → more `SerpRequest`s → breadth.
- **Persistent per-workspace cursor:** RequestQueue keyed per workspace (`uniqueKey = ws:query:page`) persisted in Redis → **a rerun resumes at the next unseen page; never repeats.** A "start fresh" flag purges the queue for a re-sweep.
- **Job visibility:** `scrape-jobs.service.ts` + `scrape_jobs` table; worker updates `status/stage/counts/reason`; `GET /api/leads/scrape/:id`; Leads modal shows live progress + terminal reason (done / blocked / exhausted).
**Acceptance:** one run returns ≥ requested count (up to page budget); an immediate rerun returns **new** leads; a block surfaces `captcha_blocked` in the UI, not silence.
**Ship gate:** the two-run "100 then another fresh 100" test passes.

### M3 — Ranking + free email enrichment · ~2 days
**Why:** best-fit first + emails so leads feed email campaigns.
**Scope:**
- `ranker.ts`: `fit_score` (title-match > synonym > keyword; seniority; location; completeness). Sort best-first; optional `minScore`.
- `email-enrich.ts` (free): company → domain (Clearbit public autocomplete, else `site:` lookup) → pattern candidates (`first.last@` …) → **MX verify** (`dns.resolveMx`) → confidence. SMTP probe hook, **default OFF**. Cache `company→domain` + `domain→pattern` in Redis.
- **Migration `0006_lead_engine.sql`:** `scrape_jobs` table; `leads` += `email_confidence`, `email_pattern`, `fit_score`. (Mirror types in `src/db/types.ts` **and** `src/db/kysely.ts`.)
- UI: score chip + email confidence indicator; exclude low-confidence emails from campaigns.
**Acceptance:** leads sorted by score; leads at resolvable-domain companies get a plausible email + confidence; unresolvable ones import cleanly with no email.

### M4 — Proxy/IP rotation + hosting (scale) · ~2–3 days
**Why:** Google blocks datacenter IPs; scale needs many IPs and off-PC hosting.
**Scope:**
- `ProxyConfiguration` + `SessionPool` wired to **own-IP nodes** (old phone + Jio SIM as mobile proxy, and/or old device at a real home tunnelled via Tailscale/cloudflared) — 1 IP per session; blocked sessions auto-retire. `SCRAPER_PROXY_URL` / rotating list.
- **VPS + Xvfb** deploy (scaffolding already built: `src/scraper-service.ts`, `deploy/scraper/*`) — run the Crawlee engine headful under Xvfb; worker offloads via `SCRAPER_SERVICE_URL` (already wired, with local fallback).
- **Multi-engine fallback:** `BingAdapter`/`BraveAdapter` behind `SearchEngine` port; engine rotation on sustained Google blocks.
**Acceptance:** scraping runs from a VPS through an own-IP node without Google-blocking; a blocked engine fails over; PC can be off *for scraping* (not outreach).

### M5 — Observability + hardening · ~1 day
**Why:** production needs to see itself.
**Scope:** per-stage metrics (leads/min, block-rate, extraction-success, dedup-hit-rate), a structured per-run report persisted to `scrape_jobs`, secret-masking in logs (censor), graceful shutdown + readiness on the scraper service.
**Acceptance:** a run produces a metrics summary; logs never leak the Gemini key or tokens.

---

## 3. Data model — migration `0006_lead_engine.sql`

`scrape_jobs` (id, workspace_id [RLS], titles jsonb, location, max_results, status, stage, counts jsonb, reason, created_at, updated_at).
`leads` += `email_confidence smallint`, `email_pattern text`, `fit_score smallint`.
Redis: `scrape:frontier:<ws>` (RequestQueue), `scrape:seen:<ws>` (URL dedup), `enrich:domain:<company>`, `enrich:pattern:<domain>`.

---

## 4. Risk register

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| patchright ✗ Crawlee `launchContext.launcher` | med | **M0 spike gates everything**; fallback = hand-built frontier over current patchright |
| Google blocks datacenter/VPS IP | high | own-IP nodes (M4) + SessionPool auto-retire + multi-engine fallback |
| Crawlee learning curve / dep weight | low | replaces more bespoke code than it adds; isolated behind the engine module |
| Split-brain (PC vs VPS code drift) | med | single git source; redeploy-both discipline; version stamped in `/health` |
| Gemini quota during expansion | low | expansion degrades to literal query; extraction degrades to regex |

## 5. What Kannan provides
- `npm i crawlee` (M1). · A Linux VPS for M4 (Oracle Always Free ARM or ~₹300–500/mo). · An own-IP node for M4 (old phone + Jio SIM, or a device at a real home). · Gemini key (already set).

## 6. Sequencing & effort
```
M0 spike (0.5d) ─GO─► M1 engine (2d) ─► M2 volume+rerun (2d) ─► M3 rank+email (2d) ─► M4 proxy+VPS (2–3d) ─► M5 observ. (1d)
```
~**9–11 days** total. **M0–M2 (~4.5d) delivers the core value** (advanced engine + the "fresh 100 on rerun" fix). M3–M5 layer on quality, enrichment, and scale.

*Plan only — no code from this doc has been built yet. M0 spike is the first action on approval.*
