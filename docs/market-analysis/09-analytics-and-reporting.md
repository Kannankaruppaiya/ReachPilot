# 09 — Analytics and reporting

## 1. Market bar
- **Expandi:** step-by-step campaign statistics, centralised dashboard across
  accounts, client-ready reports "in two clicks".
- **Dripify:** per-step delivery / acceptance / reply rates with **visual alerts
  on weak steps**, variant comparison.
- **HeyReach:** Master View KPIs across workspaces; published sender-health
  thresholds (acceptance vs 7-day baseline, pending invites, failed sends).
- **Skylead:** reply rate tied to the exact multi-step execution.
- **Benchmarks customers will compare against:** ~28.5% average connection
  acceptance in 2026 (Expandi figure quoted by Valley); cold email reply 1–3% at
  volume; warm/signal-based LinkedIn replies 15–45%.

## 2. Current state (verified)
| Area | Status | Where |
|---|---|---|
| Dashboard counters | ✅ invites/emails sent (real sends only), due today, outstanding, leads, accepted, replies, activity feed | `modules/dashboard/dashboard.service.ts` |
| Campaign list stats | 🟡 `campaign_stats` view (leads, sent, accepted %, replied %) + 14-day send trend | `campaigns.service.ts` `trendsByCampaign` |
| Connections page | 🟡 acceptance rate from lead statuses — **always 0 in production** until sync exists (doc 03) | `jobs.service.ts` `listConnections` |
| Daily rollups | 🟡 `daily_stats` keyed by LinkedIn account and **server-local date**; email sends are only counted when the job also has a LinkedIn account; replies from Gmail are attributed to the first LinkedIn account | `worker.ts` `bumpSendStats`, `gmail-inbox.service.ts` `recordReply` |
| Hourly heatmap | 🟡 `hourly_stats.hour` = **server-local hour** (UTC on the Oracle VMs), so an IST user's heatmap is shifted 5½ hours | `worker.ts`, `src/screens/Misc.tsx` `Analytics` |
| Inbox timestamps | ❌ every message shows "Today HH:MM" in server time | `inbox/inbox.service.ts` `formatTime` |
| Step analytics, A/B results, account health, reports | ❌ | — |

## 3. Gaps and how to close them

### A1 (P0) — One append-only event log, aggregated in the viewer's timezone
Pre-bucketed rollups written with the server clock are the root of the timezone
bugs. Add `outreach_events` (`workspace_id, occurred_at timestamptz, type,
lead_id, job_id, campaign_id, step_id, linkedin_account_id, email_account_id,
variant_id, meta jsonb`), written in the same transaction as the state change
(the webhook outbox of doc 08 I1 can be the same rows). Types: `invite_sent`,
`invite_accepted`, `message_sent`, `inmail_sent`, `email_sent`, `email_bounced`,
`reply_received`, `unsubscribed`, `restriction`, `checkpoint`.
Aggregate with `date_trunc('day', occurred_at AT TIME ZONE :tz)` using the
workspace timezone (add `workspaces.timezone`, default from the first LinkedIn
account). Keep `daily_stats`/`hourly_stats` only as caches, or drop them.
Fix the inbox to return ISO timestamps and format them in the browser.

### A2 (P0) — Real funnels
Per campaign, per sender, per workspace, for any date range:
- LinkedIn: invites sent → accepted (rate, **median time to accept**) → replied
  (rate) → positive replies (AI label, doc 08 I7) → meetings (manual mark or CRM).
- Email: sent → bounced → replied → positive → unsubscribed.
- Show the market benchmark next to the acceptance rate.

### A3 (P1) — Step analytics and experiment results
For each campaign step: entered, sent, skipped, failed, accepted/replied within
the step's window; drop-off to the next step; alert when a step is > 30% below
the campaign's median. Variant table with significance (doc 04 S6).

### A4 (P1) — Account health view
Per LinkedIn account: acceptance rate 14d vs its 30d baseline, pending invites,
failed sends, restrictions/checkpoints, IP/network changes (`last_ip`,
`login_ip` already stored), agent last seen + build version (already in the
heartbeat value). Drives doc 02 G6 automations.

### A5 (P1) — Reports and exports
Weekly summary email to owners (and agency clients, doc 07 M6); CSV export of any
table; PDF/white-label client report on the Agency plan.

### A6 (P2) — Insights
AI summaries over the event log ("invites mentioning a shared group are accepted
2× more"); expose the same queries to the MCP server (doc 08 I8) — Expandi's MCP
pitch is exactly "ask which campaigns actually converted".

## 4. Acceptance tests
- An invite sent at 23:30 IST is counted on that IST day, not the next UTC day.
- Email-only workspaces show email sends and replies on the dashboard.
- Median time-to-accept is computed from `invite_sent`/`invite_accepted` pairs.

## Sources
- Expandi: https://expandi.io/pricing/ · https://expandi.io/lead-generation/
- Dripify step analytics: https://dripify.com/
- HeyReach KPIs/SLAs: https://www.heyreach.io/blog/linkedin-automation-for-agencies
- Benchmarks: https://www.joinvalley.co/blog/the-best-ai-linkedin-outreach-tools-for-b2b-saas-in-2026-ranked-by-reply-rate-price-and-icp-fit
