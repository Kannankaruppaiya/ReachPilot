# PROMPT — Build the complete ReachPilot production backend

> Paste everything below this line into Antigravity (agent mode, Claude Opus 4.6),
> opened at the root of the ReachPilot repo (the folder containing `package.json`,
> `src/`, `server/`, `BACKEND_ARCHITECTURE.md`, and `server/schema.sql`).

---

## Role

You are a senior backend engineer building the production backend for
**ReachPilot**, a LinkedIn + email outreach automation SaaS (an Expandi-class
product). You work autonomously: make decisions, document them, and keep going
until the Definition of Done at the bottom is fully satisfied. Do not ask
clarifying questions — when a choice is ambiguous, pick the option most
consistent with the three source-of-truth files below and record it in
`server-v2/ADR.md`.

## Source of truth — read these three files FIRST, before writing any code

1. `BACKEND_ARCHITECTURE.md` — the target architecture (API layer, Redis/BullMQ
   queue layer, worker fleet, proxy manager, webhooks, smart-campaign graph
   engine). Follow it.
2. `server/schema.sql` — the complete PostgreSQL schema (38 tables/views:
   auth, sessions, secrets vault, workspaces, accounts, leads, campaign graph,
   jobs, inbox, webhooks, billing, analytics, RLS policies). This is the
   database contract. Apply it as migration 0001 **unchanged**; add new
   migrations only for things it lacks.
3. `server/index.js` + `src/api.ts` — the demo backend and the frontend's API
   client. Together they define the **frontend contract** (below). The React
   app must keep working without modifying anything under `src/`.

## Hard constraints (non-negotiable)

- **The existing frontend must run unchanged.** `vite.config.ts` proxies `/api`
  to `http://localhost:4000`. Your API must listen on **port 4000** and honor
  every route, request shape, response shape, status code, and validation rule
  in the "Frontend contract" section below. Error responses are always
  `{ "error": "<human-readable message>" }` with a 4xx status.
- **TypeScript everywhere. NestJS** for the API, **BullMQ + Redis** for queues,
  **PostgreSQL 15+** with `server/schema.sql` as migration 0001, **Kysely**
  (with `kysely-codegen`) for type-safe queries, **Zod** for input validation,
  **pino** for structured logging.
- **Tenant isolation via Postgres RLS**: every request-scoped DB transaction
  begins with `SET LOCAL app.workspace_id = '<uuid>'` (the schema's policies
  depend on it). Auth-service queries (users, sessions, tokens) run under a
  separate connection role that bypasses tenant scoping.
- **Secrets are never stored in plaintext.** Implement the envelope-encryption
  vault exactly as the schema models it: AES-256-GCM ciphertext in `secrets`,
  data keys in `encryption_keys` wrapped by a master key taken from the
  `MASTER_KEY` env var (a local stand-in for KMS — isolate it behind a
  `KeyManagementService` interface so a real KMS can be swapped in).
- **No real LinkedIn automation.** Implement all outbound actions behind
  provider interfaces (`LinkedInDriver`, `EmailDriver`) and ship a
  **SimulatorDriver** for each: it executes jobs with realistic latency,
  probabilistically marks invites accepted (~35%) and replied (~15%) after a
  delay, and generates inbound reply messages — so the entire system
  (queue → worker → inbox → webhooks → analytics) is fully exercisable locally.
  Real drivers are future work; the interfaces and job pipeline must not
  assume the simulator.
- **Everything runs with one command.** Provide `docker-compose.yml` (postgres,
  redis, mailhog) and npm scripts so that `docker compose up -d`,
  `npm run migrate`, `npm run seed`, `npm run start:api`, `npm run start:worker`
  bring the full stack up, and the existing `npm run web` frontend works
  against it end to end.

## Output quality rules (hard failures if violated)

- Every file you create is **complete and runnable**. Banned in all code:
  `// ...`, `// TODO`, `// implement here`, `// rest of code`,
  `/* similar to above */`, bare `...` standing in for omitted code, skeleton
  files, or describing code instead of writing it.
- Banned in prose: "for brevity", "the rest follows the same pattern",
  "left as an exercise", "you can extend this later".
- Before finishing each milestone, re-read its deliverable list and verify
  every item exists and its verification gate passes. A partial milestone is
  a failed milestone.

## Project layout

Create the backend in a new **`server-v2/`** directory (leave the demo
`server/index.js` untouched so it remains a reference):

```
server-v2/
  docker-compose.yml
  .env.example                # every env var, documented
  migrations/0001_schema.sql  # copied verbatim from ../server/schema.sql
  migrations/...              # your additions (seed plans already in 0001)
  src/
    main.ts                   # API bootstrap (port 4000)
    worker.ts                 # worker fleet bootstrap
    config/                   # zod-validated env config
    db/                       # kysely instance, RLS transaction helper, codegen types
    common/                   # guards, interceptors, error filter ({error} shape), rate limiter
    modules/
      auth/                   # signup, login, refresh rotation, Google OAuth, forgot password, TOTP MFA
      workspaces/             # workspace CRUD, memberships, invitations, onboarding state machine
      vault/                  # KeyManagementService, SecretsService (AES-256-GCM envelope)
      accounts/               # linkedin_accounts (connect, 2FA verify/skip, warm-up), email_accounts, proxies
      leads/                  # CRUD, XLSX/CSV import, dedup, blacklist
      templates/              # CRUD + {{placeholder|fallback}} renderer (port renderTemplate from src/data.ts)
      campaigns/              # CRUD, step-graph validation (no orphan nodes, no cycles except via wait)
      engine/                 # enrollment cursor, condition evaluation, next-step scheduling
      jobs/                   # send/create batching, BullMQ producers, pacing (caps, hours, jitter, warm-up ramp)
      drivers/                # LinkedInDriver + EmailDriver interfaces, SimulatorDrivers
      inbox/                  # threads, messages, reply → pause enrollment
      webhooks/               # endpoints CRUD, HMAC-signed deliveries with retry/DLQ
      notifications/          # bell feed + SSE stream (GET /api/events)
      analytics/              # dashboard, daily/hourly rollups, campaign_stats view reads
      billing/                # plans (seeded), subscriptions, invoices (Stripe-shaped, provider stubbed)
      apikeys/                # workspace API keys (prefix + sha256 hash, shown once)
      audit/                  # audit_log writes on login, secret access, limit changes
  test/                       # unit + integration + e2e (supertest against docker Postgres/Redis)
  README.md                   # setup, architecture map, how to run everything
  ADR.md                      # every non-obvious decision, dated
  PROGRESS.md                 # milestone checklist, updated as you go
```

## Frontend contract (must match exactly — port 4000, `{error}` on failure)

Onboarding (all used by `src/screens/AuthOnboarding.tsx` via `src/api.ts`):

| Route | Behavior to preserve |
|---|---|
| `GET /api/onboarding` | Returns `{ workspace, linkedin:{email,country,dedicatedIp}\|null, twofa:{status}, gmail, warmup, leadCount, leadSource, completedStep, onboardingDone }` |
| `POST /api/workspace` | `{name, goal}`; 400 `Workspace name is required.` if blank |
| `POST /api/linkedin/connect` | `{email,password,country}`; validate email format, password ≥ 6 chars, country present; store password in vault; assign proxy → return `{dedicatedIp, country}` |
| `POST /api/linkedin/2fa/verify` | `{secret}` base32 `[A-Z2-7]{16,}` after stripping spaces; store TOTP secret in vault |
| `POST /api/linkedin/2fa/skip` | marks skipped |
| `POST /api/gmail/connect` | `{dailyLimit}` clamped 20–150 |
| `POST /api/warmup` | `{dailyLimit 1–45, hoursStart, hoursEnd, weekends}`; 400 outside range |
| `POST /api/leads/import` | `{source, url?, rows?}` — rows come from client-side XLSX parse; upsert with dedup |
| `POST /api/onboarding/complete` · `POST /api/onboarding/reset` | as in demo |

Application:

| Route | Behavior |
|---|---|
| `GET /api/leads` · `PATCH /api/leads/:id` | list + partial update; 404 `Lead not found.` |
| `GET /api/templates` | list with derived `used` / `acceptPct` (template_stats view) |
| `GET/POST/PATCH /api/campaigns(/:id)` | CRUD; each campaign returned with `{leads, sent, acceptedPct, repliedPct}` from campaign_stats |
| `GET /api/threads` · `POST /api/threads/:id/messages` | threads joined with lead name/title/company + `preview`; posting appends a `from:"me"` message and clears `unread` |
| `POST /api/send/create` | `{kind: linkedin\|email, cap, rows[], template, subject}` → creates a batch of jobs spread across days by `cap`, returns `{batchId, total, today, queuedDays}`; jobs enqueue into BullMQ (not a setInterval) |
| `GET /api/send/jobs?kind=&batchId=` | job list with `status ∈ scheduled\|queued\|running\|sent\|failed` |
| `GET /api/dashboard` | `{invitesSent, emailsSent, acceptanceRate, replies, meetings, totalLeads, queuedToday, scheduled, warmup, linkedin:{country,dedicatedIp}, activity[]}` |

New surface (additive, versioned under the same prefix): `POST /api/auth/signup`,
`POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`,
`POST /api/auth/forgot`, `POST /api/auth/reset`, `GET /api/auth/google` +
callback, MFA enroll/verify, workspace invitations, webhook endpoint CRUD,
notifications list/mark-read, `GET /api/events` (SSE). During onboarding-parity
testing, auth may run in "dev bypass" mode (auto-provision a default user +
workspace when `AUTH_BYPASS=true`) so the unmodified frontend — which has no
real login wiring — still completes its flow; document this in the README.

## Engine semantics (the part that must actually work)

1. **Pacing**: per-LinkedIn-account BullMQ group with concurrency 1; daily
   counters in Redis keyed by account + local date; respect
   `warmup_daily_limit` (ramp +2/day toward `warmup_target`, persisted),
   `weekly_invite_cap`, working hours + weekend flag in the account timezone,
   and randomized 30–180 s jitter between actions. Jobs blocked by caps/hours
   are deferred, never dropped.
2. **Graph execution**: enrollment holds `current_step_id` + `next_run_at`.
   Action nodes render the template and enqueue a job; on completion advance
   via `next_step_id` after `delay_hours`. Condition nodes evaluate lead/thread
   state (`if_connected`, `if_replied`, `if_email_opened`, …) and branch
   `on_true`/`on_false`.
3. **Reply handling**: when the simulator (or a future real driver) produces an
   inbound message → upsert thread + message, set lead status `replied`, set
   enrollment status `replied` (stops the sequence), emit `reply_received`
   webhook + SSE notification, bump rollups.
4. **Idempotency**: every job carries `idempotency_key`; workers are safe to
   retry (3 attempts, exponential backoff) and route exhausted jobs to a DLQ
   with an `activity` + notification entry.
5. **Rollups**: on every sent/accepted/replied event update `daily_stats` and
   `hourly_stats` in the same transaction as the state change.

## Security checklist (verify each before final milestone)

Argon2id password hashing · refresh-token rotation with hashed tokens ·
short-lived JWT access tokens · rate limiting on auth + send endpoints ·
helmet + CORS locked to the Vite origin · Zod validation on every route ·
parameterized queries only (Kysely) · RLS active and integration-tested
(one workspace can never read another's rows — write the test) · HMAC-SHA256
`X-ReachPilot-Signature` on webhook deliveries · vault round-trip test ·
audit_log rows for login, secret read, and limits changes · no secret,
password, or token ever logged.

## Milestones — complete in order; each gate must pass before the next begins

- **M0 Scaffold**: repo layout, docker-compose, env validation, migration 0001
  applied, kysely-codegen types, health endpoint. *Gate:* `npm run migrate`
  clean on fresh DB; `GET /api/health` returns 200.
- **M1 Auth + tenancy**: signup/login/refresh/logout, forgot/reset, Google
  OAuth (behind env flag), TOTP MFA, RLS transaction helper, audit log.
  *Gate:* auth e2e suite green, RLS isolation test green.
- **M2 Onboarding parity**: vault + all onboarding routes + proxy assignment.
  *Gate:* the untouched React app completes all 6 onboarding steps against
  the new backend (AUTH_BYPASS mode), including the invalid-input error states.
- **M3 Core CRUD**: leads (+XLSX import + dedup + blacklist), templates +
  renderer, campaigns + step-graph validation. *Gate:* integration tests green;
  Leads/Campaigns/Sequences screens render real data.
- **M4 Engine**: BullMQ queues, pacing, simulator drivers, graph execution,
  send/create + send/jobs, dashboard. *Gate:* seed 50 leads, start a campaign,
  watch jobs flow scheduled→queued→sent with caps enforced; acceptance/replies
  appear over time; `GET /api/dashboard` numbers reconcile with the DB.
- **M5 Inbox + webhooks + notifications**: reply pipeline, threads API, HMAC
  deliveries with retry, SSE stream. *Gate:* simulator reply shows in Inbox
  screen unread, enrollment stops, a local webhook receiver gets a signed
  payload.
- **M6 Analytics + billing + API keys**: rollups, plan seeding, subscription
  endpoints (provider stubbed), API-key auth for the public surface.
  *Gate:* Analytics screen numbers match rollup tables; API-key request
  succeeds; revoked key 401s.
- **M7 Hardening + docs**: security checklist sweep, ≥80% coverage on engine +
  vault + auth, README + ADR complete, `PROGRESS.md` all checked. *Gate:* full
  test suite green in one run; fresh-clone setup instructions verified by
  executing them.

## Definition of Done

1. Fresh clone → documented commands → full stack running; unmodified frontend
   completes onboarding and every screen shows live backend data.
2. All milestone gates demonstrably pass; test suite green in a single run.
3. `server/schema.sql` applied unmodified as migration 0001; any additions are
   separate migrations with rationale in ADR.md.
4. Security checklist fully verified; no plaintext credential anywhere in DB,
   logs, or code.
5. No banned placeholder patterns anywhere in the delivered code or docs.
