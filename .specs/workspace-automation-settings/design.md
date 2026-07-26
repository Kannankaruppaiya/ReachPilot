# workspace-automation-settings — Design

## Architecture decision

Workspace is the single source of truth. A new `workspace_settings` table holds all
automation config; `PacingService` (the one enforcement point) reads it via a centralized
`AutomationPolicyService`. The existing per-account columns on `linkedin_accounts` stay for
backward compat but are **no longer read** by pacing (except as a defensive fallback when a
workspace has no settings row yet). Per-account warm-up *state* uses the account's
`connected_at`/`created_at` timestamp only.

**On the "4 services" in the prompt:** to avoid duplicated logic and four near-empty
classes, WorkingHours / DailyLimit / QueueScheduling are cohesive **methods of one
`AutomationPolicyService`** (the policy brain), plus a thin `WorkspaceSettingsService` for
data access. This is DRY and matches "centralize business logic." (ADR-worthy.)

## Database — migration `0004_workspace_settings.sql`

```
workspace_settings
  workspace_id            uuid PK REFERENCES workspaces(id) ON DELETE CASCADE
  working_days            smallint[]  DEFAULT '{1,2,3,4,5}'   -- 0=Sun … 6=Sat (JS getDay)
  start_time              time        DEFAULT '09:00'
  end_time                time        DEFAULT '18:00'
  timezone                text        DEFAULT 'UTC'
  daily_connection_limit  smallint    DEFAULT 20  CHECK 1..1000
  daily_invite_limit      smallint    DEFAULT 20  CHECK 1..1000
  daily_message_limit     smallint    DEFAULT 40  CHECK 1..1000
  weekly_invite_cap       smallint    DEFAULT 100 CHECK 1..2000
  random_delay_min        smallint    DEFAULT 6   -- minutes, CHECK >=0
  random_delay_max        smallint    DEFAULT 14  -- minutes, CHECK >= min
  queue_spacing           smallint    DEFAULT 6   -- minutes, base gap floor
  warmup_days             smallint    DEFAULT 28  CHECK 0..365
  warmup_target           smallint    DEFAULT 45  CHECK 1..1000
  max_concurrent_accounts smallint    DEFAULT 1   CHECK 1..1000
  pause_outside_hours     boolean     DEFAULT true
  updated_by              uuid REFERENCES users(id) ON DELETE SET NULL
  updated_at              timestamptz DEFAULT now()
  created_at              timestamptz DEFAULT now()
```
- `ENABLE` + `FORCE ROW LEVEL SECURITY`; policy `tenant_isolation USING (workspace_id = current_workspace_id())`.
- Seed: `INSERT ... SELECT id FROM workspaces ON CONFLICT DO NOTHING` (runs as migration/superuser role).
- Index: PK on workspace_id is enough (1 row/workspace).
- Add the table + row type to `src/db/types.ts` (`DatabaseSchema`).

## Backend services

### `WorkspaceSettingsService` (data access)
- `get(workspaceId)` → row (via `withWorkspace`); if missing, insert defaults then return.
- `update(workspaceId, userId, patch)` → validate → read `before` → upsert → write
  `audit_log` (`settings.update`, meta `{before, after}`) → return `after`.
- `validate(patch)` → throws `BadRequestException` with user-safe messages (AC3).

### `AutomationPolicyService` (policy brain — reads settings, no duplication)
- `getSettings(workspaceId)` → delegates to WorkspaceSettingsService (short in-memory TTL
  cache, e.g. 15s, so a burst of pacing checks doesn't hammer the DB; TTL << human edit
  latency so changes still take effect within seconds → AC7).
- `isWorkingDay(settings, now)` / `withinHours(settings, now)` → boolean (tz-aware).
- `nextWindowStartUtc(settings, now)` → ISO of the next working-day opening.
- `interactionGapMs(settings, accountId, dateIso)` → randomized min..max minutes (deterministic).
- `effectiveDailyLimit(settings, connectedAt, now)` → warm-up-ramped connection limit.
- Pure helpers are unit-testable without DB (pass settings in).

### `PacingService` refactor (the wiring)
Replace the `linkedin_accounts` column reads with `AutomationPolicyService.getSettings`:
- Working-day/weekend gate ← `working_days` (supersedes `send_weekends`); only defer when
  `pause_outside_hours` is true (AC5).
- Hours window ← `start_time`/`end_time`/`timezone`.
- Spacing ← `random_delay_min`/`max` + `queue_spacing` floor.
- Daily gate ← `effectiveDailyLimit` (warm-up from `warmup_days`/`warmup_target`).
- **New counters**: `daily_invite_limit` and `daily_message_limit` enforced with dedicated
  Redis keys (`pacing:linkedin:<acct>:date:<d>:invite|message`), gated by `isInvite` /
  message action. Weekly cap ← `weekly_invite_cap`.
- `release()` mirrors the new counters.

## API

`WorkspaceSettingsController` (`/api/workspace/settings`):
- `GET` → `WorkspaceSettingsService.get(workspaceId)`.
- `PUT` → `WorkspaceSettingsService.update(workspaceId, user.sub, body)`; validation errors
  → 400 with `{ error }` (the frontend client surfaces `error`). Follows existing manual-
  validation style (no global ValidationPipe/DTO decorators in this codebase).

## Dashboard status

Add `GET /api/workspace/settings/status` (or extend `/api/dashboard`) returning:
`{ workingHours, timezone, todayConnections, todayInvites, todayMessages, remaining{...},
nextRunAt, withinWindow }` — computed from Redis counters + settings. Dashboard renders it.

## Frontend

- `@/types`: `WorkspaceSettings` + `WorkspaceSettingsStatus`.
- `@/lib/api`: `getWorkspaceSettings()`, `saveWorkspaceSettings(patch)`, `getSettingsStatus()`.
- `@/constants`: field bounds + working-day labels (no component-level magic numbers).
- Settings screen: new **Automation** tab (Misc.tsx) with all fields — working-day
  checkboxes, start/end time, timezone select, number inputs for limits/delays/warmup,
  `pause_outside_hours` + weekend via working days, `max_concurrent_accounts`. Client-side
  validation mirrors the server; inline errors; loads current values; saves via the client;
  responsive (stacked on mobile).
- Dashboard: a "Automation status" card (working hours, today's counts, remaining, next run).

## Enforcement flow (after change)

```
User saves Settings → PUT /api/workspace/settings → validate → upsert → audit
     │
worker picks a job → PacingService.checkPacingAndRegister
     └─ AutomationPolicyService.getSettings(workspaceId)  [15s TTL cache]
         ├─ working day? in hours? (pause_outside_hours) → defer to nextWindowStartUtc
         ├─ spacing gap (random_delay_min..max) → defer
         ├─ daily connection/invite/message counters vs limits → defer to next day
         └─ weekly cap → defer
   defer ⇒ return {allowed:false, nextScheduledAt}; worker sets job scheduled_for; scheduler re-drains
```
No restart: the 15s TTL means edits propagate within seconds to every worker.

## Test strategy

Unit (jest) on `AutomationPolicyService` pure helpers (inject settings, fixed `now`):
working-hours boundary (before/at/after start & end), overnight window, working-day/weekend,
timezone difference, daily-limit-reached → next-day, spacing gap, warm-up ramp, midnight
reset (date key rollover). Validation unit tests on `WorkspaceSettingsService.validate`.
(Full multi-worker/DST E2E noted as follow-up.)

## Edge cases

- No settings row yet → `get` auto-seeds defaults.
- `working_days` empty → validation error (must pick ≥1).
- Overnight window (end < start) → same wrap logic the current pacing uses.
- Settings cache staleness bounded by TTL (≤15s), acceptable for AC7 ("no restart").
- `pause_outside_hours=false` → hours/day gates skipped, only limits/spacing apply.
