# CLAUDE.md — ReachPilot codebase map

> Read this FIRST every session. It captures the architecture, key files, and
> the non-obvious gotchas so you don't have to re-read files to understand the
> system. Update it when the architecture changes.

## What this is
ReachPilot — an Expandi-style LinkedIn + email outreach automation platform.
- **Frontend:** React + Vite + Tailwind (`src/`). Talks to the backend via `/api` (Vite proxies to :4000).
- **Backend (real):** `server-v2/` — NestJS + Postgres (Kysely) + Redis (BullMQ) + Playwright.
- **Backend (demo, ignore):** `server/index.js` — old Express mock. NOT used anymore.

## Run it
Run from the project root (`ReachPilot-main`).
- Frontend: `npm run web` → :5173
- API: `npm --prefix server-v2 run start:api` → :4000
- Worker: `npm --prefix server-v2 run start:worker` (BullMQ + Playwright + Gmail)
- Config: `server-v2/.env` (untracked; template `server-v2/.env.example`).
  Redis local `:6379` (or Upstash `rediss://`). Postgres = local `:5432` (user
  `reachpilot`) **or Supabase session pooler** — see `docs/adr/0001`.
- Kill by port (Windows): `Get-NetTCPConnection -LocalPort 4000 -State Listen).OwningProcess | Stop-Process`.
- Kill worker: `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*worker.ts*' } | Stop-Process`.

## 🔴 THE big gotcha: RLS (row-level security)
Every tenant table has **FORCE ROW LEVEL SECURITY** (migration 0003). Policy:
`workspace_id = current_workspace_id()` where `current_workspace_id()` reads the
`app.workspace_id` GUC. **Raw `getDb()` reads/writes return 0 rows / throw** on
tenant tables unless wrapped in `withWorkspace(workspaceId, db => …)` (sets the
GUC via `SET LOCAL`). This bit us repeatedly.
- **API:** every service that touches tenant tables uses `withWorkspace`.
- **Worker:** has `workspaceId` in each BullMQ job payload → wrap DB ops in `withWorkspace`.
- **Cross-tenant reads** (e.g. inbox-sync scanning all mailboxes): enumerate
  `workspaces` (NOT RLS'd) then `withWorkspace(ws.id)` per workspace.
- **NOT RLS'd** (safe with raw getDb): `workspaces`, `users`, `user_sessions`,
  `messages`, `campaign_steps`, `proxies`, `plans`.
- **The app DB user (`reachpilot`) has NO DDL rights** — can't run migrations /
  ALTER / CREATE POLICY. Migrations were applied by an admin. Don't add migrations
  expecting `npm run migrate` to work as this user.
- **Login chicken-and-egg:** `memberships` is RLS'd, so login can't read it
  without a workspace context. `AuthService.findMembership()` scans workspaces.
  Production should use a BYPASSRLS service role.

## Auth (real, `AUTH_BYPASS=false`)
- `src/modules/auth/*` — signup (argon2 + auto-login tokens), login, refresh, `GET /me`.
- Frontend: `src/lib/api/` stores tokens in localStorage, sends `Authorization: Bearer`,
  auto-refreshes on 401. `App.tsx` gates on `api.me()`. `Auth` component in
  `AuthOnboarding.tsx` = real signup/login form (Google paused).

## Drivers (swappable via env)
`src/modules/drivers/` — chosen by `LINKEDIN_DRIVER` / `EMAIL_DRIVER` env (tokens
in `driver.tokens.ts`, wired in `drivers.module.ts`).
- **GmailDriver** (`gmail.driver.ts`) — real Gmail API send (OAuth). Rich MIME:
  From display name, Reply-To, Message-ID, List-Unsubscribe, multipart HTML,
  unsubscribe footer (deliverability). `EMAIL_DRIVER=gmail`.
- **PlaywrightLinkedInDriver** (`playwright-linkedin.driver.ts`) — real browser
  automation. Full action set: `login` (cookie capture + 2FA via otplib),
  `sendConnectRequest`, `sendMessage`, `visitProfile`, `follow`, `sendInMail`,
  `likeRecentPost`, `endorseSkill`, plus read-only `syncAccount` (acceptance +
  reply detection) and `withdrawStaleInvites`. `LINKEDIN_DRIVER=playwright`.
  ⚠️ The syncAccount/withdraw/engagement selectors are LinkedIn-volatile and
  follow the same "verify working" process as the login selectors — validate
  against a throwaway account before trusting them in prod.
- **Action dispatch**: the worker routes each `ActionType` (`connect_request`,
  `linkedin_message`, `inmail`, `follow`, `visit_profile`, `like_post`,
  `endorse_skill`) to the matching driver method. Only `connect_request` marks a
  lead `invited` and counts against the weekly invite cap; other actions are
  paced by the daily counter only (`checkPacingAndRegister(..., isInvite)`).
- **LinkedInSyncService** (`linkedin-sync.service.ts`) — B4. Worker polls it
  every 5 min: per sendable account → `driver.syncAccount` → `apply()` writes
  invited→accepted / accepted→replied (+ inbox thread, auto-pause), then
  withdraws invites older than 21 days. `apply()` is idempotent and independently
  verifiable (`scripts/verify-linkedin.ts`).
- **SimulatorDriver** — fake, for dev.
- **LinkedInSessionService** — turns a `linkedin_accounts` row into a driver
  context (decrypts cookie/password/TOTP via vault, builds proxy + fingerprint).
  Pass `workspaceId` so its reads are RLS-scoped.

## 🔴 LinkedIn login selectors (change often — verified working)
- Email: `input[autocomplete="username"]` (NOT `#username`).
- Password: `input[type="password"]`.
- **Hidden duplicate inputs exist** → always `.filter({ visible: true }).first()`.
- 2FA PIN: `input[name="pin"]`. Submit: `#two-step-submit-button` (visible one).
- Sign in button: `getByRole('button', { name: /^Sign in$/ })`.

## Proxies / IP
- `PROXY_SERVER` env empty → egress via the machine's local IP (dev/testing).
- `proxies` table: `provider='local'` or `'simulator'` → treated as DIRECT egress
  (no routing) in `LinkedInSessionService.proxyFor`. Real residential proxies →
  routed. `proxy_id` is UNIQUE per account (1 proxy = 1 account).
- Local IP mode: `assignProxy` returns a `local` proxy or null → `proxy_id=null`.

## Worker (`src/worker.ts`)
BullMQ workers: `linkedin-actions`, `linkedin-login`, `email-send`,
`gmail-inbox-sync` (setInterval poll), and the **scheduler tick** (setInterval,
`SCHEDULER_TICK_MS`, default 30s). Pacing via `PacingService` (daily/weekly
caps, working hours, timezone, jitter, email warm-up ramp). Every handler wraps
DB in `withWorkspace`; commits "sent" BEFORE ancillary writes (idempotent, no
double-send). Kysely increment in onConflict: `eb('col','+',n)` — NOT `eb.bxp`.
- **Pacing deferral returns, never throws** — throwing burned all 3 BullMQ
  attempts inside the same blocked window and lost the job. The scheduler is the
  retry path now. On defer/failure the worker calls `pacing.release()` so the
  registered slot isn't double-counted on retry.

## 🔴 Scheduler (`src/modules/engine/scheduler.service.ts`) — the backbone
Jobs are inserted as `status='scheduled'` with a `scheduled_for`; only day-one
sends get pushed to BullMQ inline. **The scheduler tick is what drains the rest**
(follow-ups, drips, pacing/account deferrals). Without it, sequences never
advance past day one. Each tick enumerates `workspaces` (not RLS'd) → per-tenant
`withWorkspace` scan for due jobs → gates each → enqueues. Gates:
- **Suppression**: `leads.status ∈ {blacklisted, unqualified}` → cancel the job.
- **Account health**: LinkedIn account `status ∈ {checkpoint, paused,
  disconnected}` → re-defer +1h (defense-in-depth: `buildActionContext` also
  returns null for these, and the worker holds the job instead of failing it).
- Claims the row (`status→queued`) before enqueuing; jobId dedupes at BullMQ.
- Verify: `npx ts-node -r tsconfig-paths/register scripts/verify-scheduler.ts`.

## 🛡️ Account-safety layers (Expandi-parity — `pacing.service.ts`, `scheduler.service.ts`)
Verified by `scripts/verify-safety.ts`.
- **LinkedIn warm-up ramp**: daily cap starts at 5 and adds 3 every 2 days up to
  `warmup_target` (capped by `warmup_daily_limit`) — a cold account no longer
  fires its full quota on day one. (Email had this; LinkedIn now does too.)
- **Daily-cap randomization**: the effective daily cap is jittered ±15%
  deterministically per account/day (`seed01`), so the count varies day-to-day
  instead of a robotic constant.
- **Inter-action spacing**: a per-account Redis `lastaction` stamp enforces a
  3–6 min randomized minimum gap between actions, spreading the day's quota
  across working hours instead of bursting. Checked BEFORE the daily counter so
  a spacing defer doesn't consume a slot.
- **Duplicate-invite guard** (scheduler): a `connect_request` to a lead that
  already has a `sent` connect_request is cancelled (`last_error=duplicate_invite`).
- **Login cooldown** (`linkedin-accounts.service.ts`): `enqueueLogin` skips if a
  session cookie already exists, and a Redis `login:cooldown:<acct>` (SET NX, 6h)
  prevents repeat-login hammering — the #1 ban trigger.
- **Proxy visibility**: worker boot warns if `LINKEDIN_DRIVER=playwright` and
  `PROXY_SERVER` is empty (real automation on the local IP).
- Weekly invite cap (~100) applies to invites only; views/follows/likes/endorse
  are paced by the daily counter, not the weekly allowance.

## ⚠️ Real-account safety (learned the hard way)
- **Never repeat-login a real LinkedIn account** — rapid automated logins trigger
  LinkedIn security challenges. Design: login ONCE → store cookie → reuse cookie.
- Use throwaway accounts for testing. Warm-up + caps + working hours are the product.

## Current state (as of this session)
- ✅ Email automation (Auto Mail) end-to-end: create → worker → real Gmail send.
- ✅ Inbox backend (All + Email) + real Gmail reply send.
- ✅ Real signup/login (users stored, JWT, session restore).
- ✅ LinkedIn login mechanism PROVEN (cookie captured) — selectors/proxy/2FA fixed.
- ✅ Scheduler backbone: scheduled jobs actually run; pacing defers cleanly;
  account-health + suppression gates; timezone-correct next-window; pacing
  rollback. Verified `scripts/verify-scheduler.ts`.
- ✅ Full action set (connect/message/inmail/follow/visit/like/endorse) wired
  through worker dispatch; acceptance+reply sync (B4) via LinkedInSyncService.
  Verified `scripts/verify-linkedin.ts`.
- ⚠️ Playwright selectors for the NEW actions (sync/withdraw/engagement) are
  written to the file's established patterns but NOT yet validated against a live
  account — do that on a throwaway before enabling in prod.
- ⏳ Anti-bot hardening (login cooldown) — still open.
- Deliverability: @gmail.com cold mail → often spam. Real fix = custom domain +
  SPF/DKIM/DMARC + warm-up (infra, not code).

## Frontend structure (Vite + React)
`src/` uses the `@/` alias: `components/` (UI + Toast), `hooks/`, `lib/api/`
(client `{ api, auth }`), `lib/utils/` (cx, template), `constants/`, `types/`,
`screens/`. A file exporting components exports only components (fast-refresh).
Type-only imports use `import type` (`verbatimModuleSyntax` is on).

## Docs
- `docs/LINKEDIN_AUTOMATION_FLOW.md` — the working connect flow + 7 invariants that must
  not be broken (pacing defer returns not throws, sent-before-ancillary, etc.). Read before
  touching pacing/scheduler/driver.
- `AGENTS.md` — vendor-neutral agent guide (portable quick-start).
- `docs/adr/` — architecture decision records (e.g. 0001 Supabase migration).
- `server-v2/.env.example` — env template (copy to `.env`).
- `REACHPILOT_COMPLETE_SYSTEM_GUIDE.md` — full system design.
- `BACKEND_ARCHITECTURE.md` — backend architecture report.
