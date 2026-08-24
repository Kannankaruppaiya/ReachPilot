# LinkedIn Automation Flow (working reference)

This documents the LinkedIn connection-request automation **as it currently works**,
so future changes don't silently break the load-bearing parts. Every claim below maps
to current code (file:line). If you change any file listed under **Invariants**, re-read
that section first — those are the pieces that took the most effort to get right.

_Last verified against the running system: connection requests flowing `scheduled → queued → sent`._

## The end-to-end path

```
Auto Connect / Campaign
   → job row inserted  status='scheduled', scheduled_for=<time>, kind='linkedin', action='connect_request'
   → SchedulerService.tick()  (worker timer, SCHEDULER_TICK_MS)      [scheduler.service.ts]
        · gates each due job (suppression, duplicate-invite, account-health)
        · claims row status→'queued', enqueues to BullMQ 'linkedin-actions'
   → linkedin-actions Worker  [worker.ts:172]
        · skip if job already canceled/sent           (idempotency)   [worker.ts:181]
        · PacingService.checkPacingAndRegister(...)                    [worker.ts:192]
             ─ not allowed → job back to 'scheduled' w/ nextScheduledAt, RETURN (no throw)  [worker.ts:193-202]
        · human jitter                                                 [worker.ts:206]
        · status→'running'                                             [worker.ts:210]
        · sessions.buildActionContext(...)  → null if account unhealthy → release pacing, hold  [worker.ts:219]
        · driver.sendConnectRequest(target, message, proxy)            [playwright-linkedin.driver.ts]
        · res.status==='sent' → commit status='sent', sent_at FIRST, THEN lead='invited'  [worker.ts:277-287]
```

## Where the limits / hours come from

`PacingService.checkPacingAndRegister` [pacing.service.ts:31] reads the **`linkedin_accounts`
row** for the account and enforces, in order:
1. **Working day / weekend** — `send_weekends`, account `timezone` [pacing.service.ts:80-83].
2. **Working hours** — `hours_start`/`hours_end` (supports overnight wrap) [pacing.service.ts:88-97].
3. **Inter-action spacing** — a cool-down RE-ROLLED PER ACTION (90s–7 min, ~15% of the time
   an 8–20 min pause), held in Redis as the absolute instant the next action may run
   (`pacing:linkedin:<acct>:nextallowed`). Checked BEFORE the daily counter so a
   spacing-defer doesn't burn a slot [pacing.service.ts:128-140].
4. **Warm-up ramp + daily cap** — `computeWarmup(...)` then ±15% daily jitter; Redis daily
   counter `pacing:linkedin:<acct>:date:<d>:daily` [pacing.service.ts:113-135].
5. **Weekly invite cap** — `weekly_invite_cap`, invites only (`isInvite`) [pacing.service.ts:145-156].

A blocked check returns `{allowed:false, nextScheduledAt}` — it **defers, never throws**.

## The driver connect mechanism [playwright-linkedin.driver.ts]

- `openAccountContext(...)` builds the per-account browser (persistent profile + proxy +
  fingerprint) [driver.ts:203]; every action opens through it.
- `sendConnectRequest`: find the top-card **Connect** control (direct button, or inside the
  "More" overflow menu). When Connect is the overflow `<a>` whose href is the invite
  deep-link (`/preload/custom-invite/?vanityName=…` or `/in/…`), it **navigates to that href**
  to render the composer, then falls back to click strategies (real click → dispatch → Enter /
  centered → DOM → force) — stopping at the first that opens the invite UI [driver.ts:604-667].
- `isCheckpoint(page)` is checked after navigation/clicks; a checkpoint returns
  `{status:'checkpoint'}` and the account is paused, not retried.

## Safety gates (must stay)

- **Suppression** — jobs for `leads.status ∈ {blacklisted, unqualified}` are canceled [scheduler.service.ts:117-132].
- **Duplicate-invite guard** — a `connect_request` to a lead with an existing `sent`
  connect_request is canceled (`last_error='duplicate_invite'`) [scheduler.service.ts:137-155].
- **Account-health gate** — accounts `∈ {checkpoint, paused, disconnected}` are re-deferred
  by the scheduler [scheduler.service.ts:26,158-180] and return `null` from
  `buildActionContext` [linkedin-session.service.ts:96-110] (defense in depth).

## Current runtime config (`server-v2/.env`)

- `LINKEDIN_DRIVER=playwright` — real browser automation (not the simulator).
- `PLAYWRIGHT_HEADLESS=false` — a visible Chrome opens per action.
- `LINKEDIN_SYNC_ENABLED=false` — **the 5-min browser-opening sync is OFF** (no auto
  feed/connections/messaging browsing; accepted/reply detection + stale-invite withdrawal
  are off) [worker.ts, config/env.ts].
- `LINKEDIN_WITHDRAW_ENABLED=false` — never auto-withdraws invites.
- `PROXY_SERVER=` empty — egress via the machine's local IP (fine for a single account).

## 🔴 Invariants — do NOT break these (each cost real debugging)

1. **Pacing defer must `return`, never `throw`.** Throwing burns all 3 BullMQ attempts inside
   the same blocked window and loses the job; the scheduler is the retry path [worker.ts:190-202].
2. **Commit `status='sent'` (+`sent_at`) BEFORE the lead/ancillary writes** [worker.ts:277-287].
   Idempotent: a crash after "sent" never re-sends.
3. **Skip a job that's already `canceled`/`sent`** at the top of the handler [worker.ts:181].
4. **Scheduler claims the row (`status→'queued'`) before enqueuing**, with `jobId` dedupe +
   `removeOnComplete/Fail` at BullMQ [scheduler.service.ts:182-209]. Removing these strands
   deferred rows in `queued` forever.
5. **On defer/health-hold/failure, call `pacing.release(...)`** so the registered slot isn't
   double-counted on retry [worker.ts:221,339,358].
6. **Spacing is checked before the daily counter** [pacing.service.ts:105-111] — reordering
   makes a spacing-defer consume a daily slot.
7. **Unhealthy account → hold the job, don't fail it** (`buildActionContext` returns null)
   [worker.ts:219-221]. Failing it drops the job instead of resuming when the account recovers.

## How to change safely

- Touching pacing/scheduler/driver? Keep the seven invariants above. Prefer adding a new
  gate over reordering the existing ones.
- Test connect flow against a **throwaway** account, one run at a time (live runs bypass
  pacing and rate-limit an account).
- After any driver/selector change, watch a real run (`PLAYWRIGHT_HEADLESS=false`) and confirm
  the invite composer opens for the **correct** profile before trusting it.
