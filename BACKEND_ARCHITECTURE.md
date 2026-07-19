# ReachPilot — Backend Architecture Report

*An Expandi-style LinkedIn + email outreach automation platform.*
*Prepared from: the existing frontend/demo server in this repo, and the Expandi pages on LinkedIn outreach, Smart Campaigns, and the Smartlead email integration.*

---

## 1. Executive summary

The frontend in this project (`ReachPilot`) is a faithful clone of an Expandi-class
outreach tool: workspace onboarding, LinkedIn account connection with a dedicated
country IP, 2FA, Gmail connection, warm-up limits, lead import from Excel, a smart
campaign builder, Auto Connect / Auto Mail send engines, a unified inbox, and
analytics. Today it is backed by a **single-process demo** — one Express server
(`server/index.js`), a flat `data.json` "database", and a `setInterval` loop that
"sends" one queued job every 1.5 seconds. That is perfect for a UI demo but cannot
run a real outreach product.

This report describes the **production backend** that would sit behind that same
frontend. The core problem is not CRUD — it is running thousands of **stateful,
rate-limited, human-like automation sessions against LinkedIn** (which forbids
automation) and against email, safely and per-tenant, 24/7. The architecture below
is organized around that reality: an API layer for the app, a **job/queue layer** for
scheduling, and a **worker/automation layer** that drives real LinkedIn sessions
through per-account residential proxies, plus webhooks and CRM sync.

Recommended stack: **Node.js/TypeScript (NestJS)** API, **PostgreSQL** (multi-tenant
system of record), **Redis + BullMQ** (queues, scheduling, rate limiting),
**dedicated automation workers** (Playwright-driven LinkedIn sessions), an
**email-sending service** (or Smartlead/ESP integration), object storage for
attachments, and observability via OpenTelemetry.

---

## 2. What the current demo does (baseline)

| Concern | Demo implementation | Why it doesn't scale |
|---|---|---|
| Persistence | `data.json` read/written on every mutation | No concurrency, no query, corrupts under load, single node only |
| "Sending" | `setInterval(processQueueTick, 1500)` sends 1 job/tick | No LinkedIn/email actually contacted; no per-account isolation; dies with the process |
| Auth | None — global singleton `db` | No users, no tenants, no sessions |
| LinkedIn connect | Generates a fake `103.x.x.x` IP string | No real proxy, no real session, no cookie/2FA handling |
| Scheduling | `day = floor(index / perDay)`, midnight buckets | No per-account limits, no working hours, no jitter, no retries |
| Inbox | Static threads in JSON | No reply detection, no polling of LinkedIn/email |

The demo already models the **right domain objects** — leads, campaigns, templates,
threads, `sendJobs`, warm-up config, dedicated IP. The production design keeps those
concepts and makes each one real and durable.

---

## 3. High-level architecture

```
                          ┌───────────────────────────────────────┐
                          │            Client (React SPA)           │
                          └───────────────────┬─────────────────────┘
                                              │ HTTPS / JSON, JWT
                                    ┌─────────▼──────────┐
                                    │   API Gateway /    │  auth, rate limit,
                                    │   Load Balancer    │  TLS, routing
                                    └─────────┬──────────┘
                                              │
                    ┌─────────────────────────┼──────────────────────────┐
                    │                          │                          │
          ┌─────────▼─────────┐      ┌─────────▼─────────┐      ┌─────────▼─────────┐
          │   App API service │      │  Webhook service  │      │  Realtime service │
          │   (NestJS/REST)   │      │  (in + out)       │      │  (WebSocket/SSE)  │
          └────┬─────────┬────┘      └────────┬──────────┘      └─────────┬─────────┘
               │         │                    │                           │
     ┌─────────▼──┐  ┌───▼─────────────┐  ┌───▼───────────────────────────▼──┐
     │ PostgreSQL │  │ Redis + BullMQ  │  │        Object storage (S3)        │
     │ (tenants,  │  │ queues, sched., │  │  attachments, exports, images     │
     │  leads,    │  │ rate limits,    │  └───────────────────────────────────┘
     │  campaigns,│  │ locks, cache    │
     │  jobs,     │  └───┬─────────────┘
     │  messages) │      │ jobs dispatched
     └────────────┘      │
              ┌──────────┴───────────────────────────────────┐
              │            Worker fleet (autoscaled)           │
              │                                                │
   ┌──────────▼──────────┐  ┌──────────▼──────────┐  ┌─────────▼──────────┐
   │ LinkedIn automation │  │  Email send worker  │  │  Inbox sync worker │
   │ worker              │  │  (ESP / Smartlead)  │  │  (poll replies)    │
   │ Playwright session  │  └─────────────────────┘  └────────────────────┘
   │  per LinkedIn acct  │
   └──────────┬──────────┘
              │ 1 dedicated residential/mobile proxy per account
   ┌──────────▼──────────┐
   │   Proxy pool mgr     │──▶  LinkedIn        (country-matched egress IP)
   └──────────────────────┘
```

The three layers that matter:

1. **API layer** — synchronous, stateless, horizontally scalable. Serves the SPA,
   validates input, writes to Postgres, enqueues work. Never talks to LinkedIn.
2. **Queue/scheduler layer** — Redis + BullMQ. Turns campaign steps into
   time-scheduled, rate-limited, per-account jobs. The brain of pacing and safety.
3. **Worker/automation layer** — long-running processes that actually perform
   actions (open a LinkedIn session through the account's proxy, send a connect,
   send an email, read replies) and report results back.

---

## 4. Component design

### 4.1 API service (NestJS / TypeScript)
- **Responsibilities:** authentication, tenant/workspace management, onboarding,
  CRUD for leads/campaigns/templates/threads, campaign start/pause, analytics reads.
- **Maps directly to the demo's routes** — `/api/workspace`, `/api/linkedin/connect`,
  `/api/warmup`, `/api/leads/import`, `/api/campaigns`, `/api/send/create`,
  `/api/threads`, `/api/dashboard` — but each becomes tenant-scoped and persisted.
- **Validation** with Zod/class-validator (the demo already validates email, 2FA
  base32, warm-up range 1–45 — keep and formalize these).
- **Never blocks on outreach**: `POST /campaigns/:id/start` enqueues, returns `202`.

### 4.2 Datastore — PostgreSQL (multi-tenant)
- **Tenancy model:** shared database, shared schema, **`workspace_id` on every row**
  + Postgres Row-Level Security. Simplest to operate; RLS enforces isolation even if
  a query forgets the filter. (Move to schema-per-tenant or DB-per-tenant only for
  large/enterprise accounts.)
- **Core tables:**
  - `workspaces`, `users`, `memberships` (granular roles: owner/admin/member — the
    frontend already promises "granular roles").
  - `linkedin_accounts` (encrypted session cookies, assigned proxy id, country,
    dedicated IP, warm-up state, daily-limit ramp).
  - `email_accounts` (OAuth tokens for Gmail/O365 or SMTP creds, daily cap,
    warm-up state).
  - `leads` (the demo's shape: name, title, company, linkedinUrl, email,
    emailVerified, status, tags, source).
  - `campaigns`, `campaign_steps` (the smart-sequence graph: actions + conditions),
    `campaign_enrollments` (a lead's position in a sequence).
  - `jobs` / `send_jobs` (durable version of the demo's `sendJobs`), `messages`,
    `threads`, `activity`.
  - `webhook_endpoints`, `integrations`, `blacklist`, `duplicates_index`.
- **Secrets** (LinkedIn cookies, OAuth tokens) encrypted at rest with envelope
  encryption (KMS-managed data keys); never returned to the client.

### 4.3 Queue & scheduler — Redis + BullMQ
This replaces the `setInterval` tick and is where "safe automation" actually lives.
- **One logical queue per capability:** `linkedin-actions`, `email-send`,
  `inbox-sync`, `enrichment`, `webhooks`.
- **Per-account concurrency = 1.** A LinkedIn account must never run two actions at
  once. Enforced with a **Redis lock / BullMQ group keyed by `linkedin_account_id`**.
- **Rate limiting & pacing** (the real version of warm-up):
  - Daily caps per account (demo: 1–45 connects/day) tracked in Redis counters that
    reset on the account's local midnight.
  - **Warm-up ramp:** start low (e.g. 18/day as the UI shows), increase gradually
    over ~2 weeks toward full capacity.
  - **Working-hours windows** (demo already stores `hoursStart`/`hoursEnd`/`weekends`)
    — jobs outside the window are deferred, not sent.
  - **Human jitter:** randomized delays between actions (minutes, not the fixed
    1.5s tick), randomized action order.
- **Delayed jobs** for multi-day sequences (replaces `day = floor(i / perDay)`).
- **Retries with backoff** for transient failures; dead-letter queue for repeated
  failures (e.g. LinkedIn checkpoint → pause account, alert user).

### 4.4 Worker fleet
- **LinkedIn automation worker** — the hardest part. Each job:
  1. Loads the account's encrypted session + **its dedicated proxy** (country-matched
     residential/mobile IP — the real version of the demo's fake `103.x.x.x`).
  2. Drives a headless browser (**Playwright**) or LinkedIn's private endpoints to
     perform the action: visit profile, follow, send connection request, message,
     InMail, like a post (Expandi's "9 actions between messages").
  3. Detects **checkpoints/CAPTCHA/2FA** and account-health signals; on trouble it
     pauses the account and surfaces it in the UI instead of pushing through.
  4. Writes the result (sent/failed/accepted) back to Postgres and emits an event.
- **Email send worker** — sends via the tenant's connected mailbox (Gmail/O365 OAuth
  or SMTP) **or** hands off to an ESP/Smartlead. Honors per-mailbox daily caps
  (~50/day), warm-up, SPF/DKIM/DMARC alignment, unsubscribe handling.
- **Inbox sync worker** — polls LinkedIn conversations and email (IMAP/Gmail API) for
  **replies**; a reply auto-pauses that lead's sequence (matching Expandi behavior)
  and creates/updates a `thread` in the unified inbox.
- Workers are **stateless and autoscaled**; the account's state lives in Postgres/Redis.

### 4.5 Smart-campaign engine (the "if-then" sequences)
The frontend advertises **19 actions + 11 conditions** in a drag-and-drop builder
with real-time if-then logic. Model this as a **directed graph state machine**:
- `campaign_steps` = nodes. Two node kinds:
  - **Actions:** connect, message, InMail, email, visit profile, follow, like post,
    endorse, wait/delay, enrich, webhook, move-to-campaign, etc.
  - **Conditions (branch):** `if connected`, `if replied`, `if email opened`,
    `if InMail opened`, `if profile visited`, `if post liked`, etc. Each has
    true/false edges.
- A per-lead **enrollment** holds a cursor (current node) + timers. When a step
  completes, the engine evaluates outgoing edges and **enqueues the next step as a
  delayed job**. Condition evaluation reads state that the workers and inbox-sync
  keep fresh (accepted? replied? opened?).
- This makes campaigns **event-driven**: an "invite accepted" webhook/poll result
  advances the graph in near-real-time rather than on a fixed clock.

### 4.6 Webhooks & integrations (in and out)
- **Outbound webhooks:** on events (`invite_accepted`, `reply_received`,
  `email_opened`), POST signed payloads (HMAC signature header) to tenant-configured
  endpoints with retries + delivery log. This is Expandi's "webhook pushes reply data
  to your endpoint" model, and the frontend already has an Integrations screen.
- **Inbound / bidirectional:** the Smartlead-style integration — Expandi pushes
  qualified leads to the email tool, and email engagement (open/click/reply) triggers
  LinkedIn steps. Implement as an **integration adapter** per partner (Smartlead,
  HubSpot, Zapier) behind a common interface; sync in near-real-time (the article
  cites ~45-minute processing windows for lead intake).
- **CRM sync:** HubSpot/Salesforce connectors write replies and status back.

### 4.7 Proxy / IP management
- **One dedicated, country-matched egress IP per LinkedIn account** — non-negotiable
  for account safety and the product's core promise. A **proxy pool manager** assigns
  a residential/mobile proxy at account-connect time and pins it for the account's
  lifetime (LinkedIn flags IP churn). Health-checks proxies; on failure, rotates to a
  same-geo replacement and logs it.

### 4.8 Realtime layer
- WebSocket/SSE service pushes live updates to the SPA (queue progress, new replies,
  account warnings) so the dashboard's activity feed and "Connected · Warming up
  18/day" badge reflect reality without polling.

---

## 5. Request/data flows

**A. Connect a LinkedIn account (onboarding step 2)**
```
Client → API /linkedin/connect
  → API stores account (status=connecting), assigns proxy from pool
  → enqueue linkedin-login job
Worker → logs in through the account's proxy, handles 2FA
  → stores encrypted session cookies, sets country + dedicated IP
  → emits account.connected → realtime push → UI shows dedicated IP
```

**B. Launch a smart campaign**
```
Client → API /campaigns/:id/start (202 Accepted)
  → API creates enrollments for all leads at the graph's entry node
  → enqueue first step per lead as delayed jobs (respecting caps/hours/jitter)
Scheduler → releases jobs within daily cap & working hours
LinkedIn worker → performs action via proxy → writes result
Engine → evaluates conditions → enqueues next delayed step
Inbox-sync → detects reply → pauses that lead's sequence → creates thread
  → fires outbound webhook + realtime push
```

**C. Multichannel (LinkedIn + email) with Smartlead**
```
Email opened (Smartlead webhook) → API → engine advances lead
  → enqueue LinkedIn "send message" step
Connect not accepted after N days (condition) → enqueue email follow-up step
```

---

## 6. Cross-cutting concerns

- **Security (OWASP-aligned):** JWT/OAuth2 sessions, Argon2id password hashing,
  parameterized queries (Postgres), per-tenant RLS, encrypted secrets, HMAC-signed
  webhooks, strict input validation, secrets in a vault/KMS. Rate-limit the public API
  independently of the outreach pacing.
- **Multi-tenancy & roles:** every query scoped by `workspace_id`; RBAC for
  owner/admin/member; agency "white-label" = workspace hierarchy + per-workspace
  branding.
- **Observability:** OpenTelemetry traces across API → queue → worker; per-account
  dashboards (sends, accept rate, health); alerting on checkpoints, proxy failures,
  DLQ growth. Structured logs, no PII in logs.
- **Idempotency & dedup:** idempotency keys on send jobs; the demo's "duplication
  security at personal and company level" becomes a `duplicates_index` unique
  constraint on `(workspace_id, lead_identity)` plus a shared `blacklist`.
- **Reliability:** at-least-once job delivery + idempotent workers; graceful account
  pause on LinkedIn defense signals; retries with jittered backoff; DLQ + manual
  requeue.
- **Compliance caveat:** LinkedIn's User Agreement prohibits third-party automation.
  The entire safety design (dedicated IPs, human pacing, warm-up, conservative caps,
  checkpoint detection) reduces — but never eliminates — account-restriction risk.
  This should be surfaced to users and reflected in conservative defaults.

---

## 7. Technology choices (summary)

| Layer | Choice | Rationale |
|---|---|---|
| API framework | Node.js + NestJS (TypeScript) | Same language as the SPA; structured DI, guards, validation |
| System of record | PostgreSQL + RLS | ACID, relational campaign/lead data, strong tenant isolation |
| Queue / scheduler | Redis + BullMQ | Delayed jobs, per-key concurrency, rate limits, retries, DLQ |
| Automation | Playwright workers, 1 session/account | Real LinkedIn actions; checkpoint handling |
| Email | Gmail/O365 OAuth or SMTP; or Smartlead/ESP | Deliverability, warm-up, SPF/DKIM/DMARC |
| Proxies | Residential/mobile, 1 dedicated IP/account | Account safety, country match |
| Object storage | S3-compatible | Attachments, exports, personalized images |
| Realtime | WebSocket/SSE gateway | Live queue/inbox updates |
| Secrets | KMS + envelope encryption | Protect session cookies & OAuth tokens |
| Observability | OpenTelemetry + Prometheus/Grafana | Traces, per-account health, alerting |

---

## 8. Migration path from the current demo

1. **Replace `data.json` with Postgres** behind the existing route shapes (lowest-risk
   first step; API contract to the SPA stays identical).
2. **Introduce auth + `workspace_id`** on every entity; enable RLS.
3. **Swap the `setInterval` tick for BullMQ** — move `send/create` to enqueue delayed,
   rate-limited jobs; keep the same job fields (`kind`, `leadId`, `day`, `status`).
4. **Add a real LinkedIn worker + proxy manager**; replace the fake dedicated-IP
   generator with real proxy assignment.
5. **Add inbox-sync + webhooks**; make the campaign engine event-driven.
6. **Add email sending / Smartlead integration** for true multichannel.
7. **Harden:** secrets encryption, observability, autoscaling, DLQ handling.

The frontend does not need to change during steps 1–3; the API keeps its current
endpoints and only their implementation and durability change.
