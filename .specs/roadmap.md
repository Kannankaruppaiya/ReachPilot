# ReachPilot — Roadmap (reconciled state)

Reconciles `REACHPILOT_COMPLETE_SYSTEM_GUIDE.md` (§10, §16) with the current
`CLAUDE.md` and the code. The system guide's roadmap is **out of date** — much of
its "Phase 1/2" is now built. This is the accurate picture of what's DONE and what
REMAINS. Treat "remaining" as the backlog to turn into `.specs/<feature>/` folders.

## ✅ Done (the ~30% "foundation" is really more like a working core)

- NestJS API, modular, tenant-scoped; Postgres + Kysely + **RLS** (FORCE) per workspace.
- Redis + BullMQ queues; the **scheduler tick** that drains scheduled jobs.
- Auth: signup (argon2), login, JWT access/refresh, session restore.
- **PacingService** — daily/weekly caps, working hours, timezone, jitter, warm-up ramp,
  inter-action spacing, duplicate-invite guard, login cooldown.
- Campaign graph engine (executor + condition evaluator).
- **Drivers**: `SimulatorDriver` and a **real `PlaywrightLinkedInDriver`** (login +
  cookie capture proven; full action set: connect/message/inmail/follow/visit/like/endorse).
- Cookie-based onboarding (`connect-cookie`) + envelope-encryption vault (`MASTER_KEY`).
- **LinkedInSyncService** (acceptance/reply sync) + Gmail send + inbox (All + Email).
- **WarmupBrowseService** (passive human-presence browsing, zero actions).
- Frontend: all screens, responsive (verified 375px), `@/` structure.

## 🔶 Remaining (the real backlog — the "70%")

Grouped by workstream, roughly in priority order. `P0` = blocks safe real use.

### A. Reliability & correctness (P0) — mostly this session's findings
- **[auth-session-reliability](auth-session-reliability/)** — fix the refresh-token
  race that logs users out on limit change / after token expiry. **Spec written.**
- **Frontend hook-deps** — 4 `react-hooks/exhaustive-deps` warnings (Inbox, Connections,
  Misc, AutoSend) need careful, per-case fixes (risk: infinite refetch loops).
- **Testing foundation** — there is little/no automated test coverage. Add unit tests
  for pacing/scheduler/RLS wrappers and **Playwright E2E** for the critical flows
  (signup → onboarding → connect → send). Use the `e2e-testing` skill.

### B. LinkedIn automation hardening (P0)
- **[linkedin-driver-hardening](linkedin-driver-hardening/)** — validate the NOT-yet-live
  selectors (sync/withdraw/engagement), lock in the custom-invite route-abort fix,
  the shared cross-loop browser cooldown, checkpoint→pause→notify, and stealth patches
  (`playwright-extra`). **Spec written.**
- **Proxy pool manager** — assign + pin + health-check real residential IPs (currently
  local-IP mode only; 1 proxy = 1 account via the unique constraint).

### C. Multichannel & feedback loop (P1)
- Email deliverability — custom domain + SPF/DKIM/DMARC + warm-up (infra, not code).
- Outbound **signed webhooks** + CRM integrations (HubSpot / Zapier).
- **Realtime** WebSocket/SSE — live queue/inbox/account-status to the SPA (replaces
  the 60s poll, which also removes a trigger of the auth race in A).

### D. Compliance & data hygiene (P1)
- **Unsubscribe handling** + shared **blacklist** + suppression across workspaces.
- Global **dedup index** (don't contact the same lead twice across campaigns).

### E. Harden & scale (P2)
- Observability: pino → OpenTelemetry traces, per-account health dashboards, alerting.
- **DLQ** handling + manual requeue for poisoned jobs.
- Autoscale the worker fleet by queue depth.
- Secrets: move `MASTER_KEY` envelope encryption to a real KMS.

### F. Productionization (P1)
- **Deployment** — frontend (Vercel/static) + API/worker (container) + managed
  Postgres (Supabase) + Redis (Upstash). Env, migrations, health checks, CI.
- Convert `AUTH_BYPASS`, `LINKEDIN_DRIVER=simulator` etc. to safe prod defaults.

## How to work this roadmap

Pick an item → create `.specs/<feature>/{requirements,design,tasks}.md` (copy the
structure of the two written specs) → get requirements agreed → design → tasks →
build. Record any weighty decision as an ADR in `docs/adr/`.
