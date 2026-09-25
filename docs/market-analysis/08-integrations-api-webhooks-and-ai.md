# 08 — Integrations, public API, webhooks, and AI / MCP

## 1. Market bar

| Integration | Expandi | HeyReach | Dripify | Waalaxy | LGM | ReachPilot today |
|---|---|---|---|---|---|---|
| Outgoing webhooks | every action | ✅ | ✅ (Pro+) | via Make/Zapier | ✅ | 🟡 tables + CRUD service; **nothing ever fires**, no delivery worker |
| Public API | open API | ✅ | ❌ | ❌ | ✅ | 🟡 API-key auth works (now RLS-safe); no docs, no key UI, scopes unused |
| HubSpot | native | native | native | native | native (timeline + workflows) | ❌ "coming soon" (`src/screens/Misc.tsx:513`) |
| Pipedrive / Salesforce | native | via Make | — | Pipedrive | Pipedrive | ❌ |
| Zapier / Make / n8n | ✅ | Make, n8n | Zapier (webhook) | modules for all 3 | Zapier, Make | ❌ |
| Clay | — | ✅ | — | — | ✅ | ❌ |
| Cold-email tools (Instantly, Smartlead) | — | ✅ native | — | — | — | ❌ |
| Slack notifications | — | dedicated channel | — | — | ✅ | ❌ |
| MCP server (AI assistants run the tool) | Expandi MCP (early access) | HeyReach MCP | — | — | — | ❌ (but an in-app AI Assistant with 9 tools exists) |
| AI reply handling | — | tags replies via MCP | — | Waalaxy AI agent | — | ❌ |

## 2. Current state (verified)

- **Webhooks:** `modules/webhooks/webhooks.service.ts` can list/create/remove
  endpoints (with a `whsec_` secret) and `triggerEvent()` writes
  `webhook_deliveries` rows and adds jobs to a `webhook-deliveries` BullMQ queue.
  But **`triggerEvent` has no callers** and **no worker consumes that queue**
  (`worker.ts` starts linkedin-actions, linkedin-login, email-send, lead-scrape
  only). There is no UI (the frontend API client has no webhook calls).
- **API keys:** `modules/apikeys/*` + `common/auth.guard.ts` — keys now carry
  their workspace (commit "fix(engine) …"); `api_keys.scopes` exists but nothing
  checks it; API-key callers get role `member`; no key-management UI.
- **AI:** Gemini (`modules/ai/ai.service.ts`), AI connection notes with Apify
  profile research (`ai/connection-note.service.ts`), and an **Assistant** agent
  (`ai/ai-agent.service.ts`) with tools `search_leads`, `get_account_status`,
  `list_campaigns`, `scrape_leads`, `get_connections`, `get_stats`, `get_inbox`,
  `list_email_accounts`, `get_recent_activity`, plus Apify MCP tools
  (`ai/apify-mcp.service.ts`). ReachPilot is an MCP *client* today, not a server.
- **Real-time:** SSE stream `GET /api/events` (`notifications.controller.ts`).

## 3. Gaps and how to close them

### I1 (P0) — Make webhooks real
1. **Event catalogue** (versioned payloads, all with `workspace_id`, `lead`,
   `campaign`, `account`, `occurred_at`):
   `lead.created`, `invite.sent`, `invite.accepted`, `message.sent`,
   `email.sent`, `email.bounced`, `reply.received` (+ AI label),
   `lead.unsubscribed`, `enrollment.finished`, `account.halted`
   (checkpoint / signed-out / limit).
2. **Emit after commit** from the existing places: worker sent branch, sync
   `apply` (doc 03), Gmail reply detection, `haltAccount`. Use a transactional
   outbox (insert `webhook_deliveries` in the same transaction as the state change,
   enqueue after commit) so an event is never lost or sent for a rolled-back change.
3. **Delivery worker** in `worker.ts`: POST JSON with
   `X-ReachPilot-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`,
   10 s timeout, retries with exponential backoff (1 min → 6 h, 8 attempts), mark
   `webhook_deliveries.status`/`attempts`/response code; auto-disable an endpoint
   after 100 consecutive failures and notify.
4. **SSRF guard:** HTTPS only; resolve DNS and refuse private/loopback/link-local
   ranges and the cloud metadata IP.
5. **UI:** Integrations → Webhooks: add endpoint, choose events, reveal secret
   once, "send test event", delivery log with replay.
6. **Campaign step** `fire_webhook` (enum value already exists) for
   "when this lead reaches step N, call my URL".

### I2 (P1) — Public REST API v1 + key management
- Namespace `/api/v1/*`, generated OpenAPI docs (`@nestjs/swagger`).
- Resources: leads (list/create/update/import), lists/tags, campaigns (list,
  stats, enroll leads, pause/resume), enrollments, threads/messages (read, reply),
  accounts (status, limits read-only), webhooks.
- **Scopes** enforced by a guard (`leads:read`, `leads:write`, `campaigns:write`,
  `inbox:read`, `inbox:write`, `webhooks:write`) using the existing
  `api_keys.scopes` column; per-key rate limits (Redis, like `RateLimiterGuard`).
- Settings → API keys: create (show once), revoke, last used (the service and
  column already exist).

### I3 (P1) — Zapier, Make, n8n
Build on I1 + I2 (no special backend): triggers = webhook events
(`reply.received`, `invite.accepted`, …); actions = "add lead to campaign",
"create lead", "pause lead". Waalaxy ships modules for all three; this is the
cheapest way to reach 2,000+ apps.

### I4 (P1) — Native HubSpot, then Pipedrive, then Salesforce
HubSpot first (most requested in this segment):
1. OAuth app (scopes: contacts, timeline/engagements, lists).
2. On events: upsert contact by email, else by LinkedIn URL property; log
   engagements (invite sent/accepted, message, reply) on the contact timeline —
   LGM and HeyReach both do "every connection, message and reply shows up on your
   HubSpot contacts".
3. Two-way: import a HubSpot list into a campaign; optional lifecycle stage update
   on positive reply.
4. Store tokens via the vault (`vault/secrets.service.ts`, `integrations` table —
   same pattern as Apify).

### I5 (P1) — Slack notifications
Per-workspace Slack incoming-webhook URL: new reply (with AI label), account
halted, daily summary. Reuse the notification points above.

### I6 (P1) — Hand-off to cold-email platforms instead of building a mail fleet
Actions "add lead to Instantly campaign" / "add lead to Smartlead campaign" (their
APIs), triggered by a step or a condition ("not accepted after 14 days") — the
model HeyReach uses (doc 06 §2).

### I7 (P1) — AI reply copilot, then autopilot
1. Classify every inbound reply (Interested / Meeting request / Not interested /
   Not now / OOO / Referral / Unsubscribe) with Gemini; store on the thread; drive
   automation (doc 03 §4, doc 05 L4).
2. **Copilot:** draft a reply in the user's voice with lead context and the
   conversation; the user edits/approves in the inbox.
3. **Autopilot** (opt-in per campaign) only for narrow intents (e.g. OOO
   reschedule, sending a calendar link to "send me a time"), with a daily cap and a
   full audit log. Instantly and SalesRobot sell this; Valley shows the demand for
   "human approval by default".

### I8 (P2) — ReachPilot MCP server
Expandi and HeyReach launched MCP servers in 2026 so users can run outreach from
Claude/ChatGPT. ReachPilot already has the tool implementations in
`ai-agent.service.ts`. Package them (read-only first: campaigns, stats, inbox,
leads search; then write: create campaign from a list, enroll, draft reply) as an
MCP server authenticated by API key (I2) with the same scopes. This turns the
existing Assistant work into a distribution channel.

## 4. Acceptance tests
- A sent invite produces exactly one `invite.sent` delivery; a rolled-back
  transaction produces none; the receiver can verify the signature.
- Webhook to `http://169.254.169.254/…` or `https://localhost` is rejected at
  creation.
- An API key with only `leads:read` gets 403 on `POST /api/v1/campaigns/:id/enroll`.
- HubSpot sync upserts one contact per lead across repeated events.

## Sources
- Expandi integrations & MCP: https://expandi.io/lead-generation/ · https://expandi.io/back-to-pipeline-2026/
- HeyReach integrations & MCP: https://www.heyreach.io/ · https://www.heyreach.io/for-agencies
- Dripify webhooks: https://www.linkedhelper.com/reviews/dripify-review
- Waalaxy integrations: https://www.waalaxy.com/feature/linkedin-prospecting · https://www.waalaxy.com/pricing
- La Growth Machine CRM sync: https://lagrowthmachine.com/pricing/
- Instantly AI reply agent: https://instantly.ai/blog/comparing-instantly-vs-smartlead/
