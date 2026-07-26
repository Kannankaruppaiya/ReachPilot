# workspace-automation-settings — Requirements

- **Status:** In progress
- **Priority:** P0
- **Decision:** Workspace is the **source of truth** for automation settings (per
  AskUserQuestion). Per-account `linkedin_accounts` columns are superseded by
  `workspace_settings`; the account keeps only per-account *state* (warm-up start).

## Problem

Working hours, timezone, and connection/invite/message limits are currently stored
**per LinkedIn account** on `linkedin_accounts`, only two fields are editable in the UI
(daily limit + weekly cap), and several controls the product needs (per-day invite/
message limits, delay ranges, warm-up length, weekend/working-days, pause-outside-hours,
max concurrent accounts) don't exist. We need one **workspace-level** configuration that
is dynamic, validated, and enforced consistently everywhere with **no restart**.

## User stories

1. As an operator, I configure working days/hours/timezone once for my workspace and all
   automation obeys them.
2. As an operator, I set daily connection/invite/message limits and delay ranges, and the
   pacing engine enforces exactly those.
3. As an operator, when I change a setting, in-flight and future queued jobs respect the
   new values without a server restart.
4. As an operator, the dashboard shows today's counts, remaining quota, working hours, and
   the next time automation will run.
5. As an admin, every settings change is audited (who, when, before → after).

## Acceptance criteria (EARS)

- **AC1** — The system SHALL persist automation settings per workspace in a
  `workspace_settings` table under RLS, with one row auto-created per workspace.
- **AC2** — WHEN a user opens Settings → Automation, the system SHALL display the
  workspace's current values loaded from the backend (no hardcoded component defaults).
- **AC3** — WHEN a user saves settings, the system SHALL validate every field and return
  user-safe messages for: time range (end after start unless overnight), limits (positive,
  within bounds), timezone (valid IANA), working days (non-empty subset of Sun–Sat),
  delay range (min ≤ max, positive).
- **AC4** — WHILE an action is being paced, the system SHALL read the **workspace settings**
  (not per-account columns) for working days, hours, timezone, daily/weekly limits,
  delay/spacing, and warm-up.
- **AC5** — IF the current local time is outside working days/hours AND `pause_outside_hours`
  is true, THEN the system SHALL NOT execute and SHALL reschedule to the next working window.
- **AC6** — IF a daily limit (connection/invite/message) is reached, THEN the system SHALL
  NOT fail the job but reschedule it to the next available working day.
- **AC7** — WHEN workspace settings change, future scheduler ticks and pacing checks SHALL
  use the new values automatically (no restart, no code change).
- **AC8** — The dashboard SHALL show working hours, today's connection/invite/message counts,
  remaining daily quota, and the next available run time.
- **AC9** — WHEN settings are updated, the system SHALL write an `audit_log` row
  (`action='settings.update'`, `meta={before, after}`, `user_id`, `workspace_id`).
- **AC10** — All tenant DB operations SHALL use `withWorkspace()` and respect RLS.
- **AC11** — No hardcoded limits/hours/delays anywhere in the enforcement path; all values
  come from `workspace_settings` (with typed defaults only at the schema/DTO layer).

## Configurable fields

working_days, start_time, end_time, timezone, daily_connection_limit, daily_invite_limit,
daily_message_limit, weekly_invite_cap, random_delay_min, random_delay_max, queue_spacing,
warmup_days, warmup_target, max_concurrent_accounts, pause_outside_hours.

## Non-goals (this iteration)

- Per-account overrides of workspace settings (chosen model = workspace source of truth).
- Real residential proxy pool / multi-account scale-out (separate spec).
- Full DST-library correctness (approximate offset is acceptable — the scheduler re-checks
  and self-corrects, as the existing pacing already does).

## Definition of done

Changing a setting in the UI immediately affects DB, API responses, pacing, scheduler,
BullMQ deferrals, dashboard metrics, and future jobs — no restart. Core policy logic is
unit-tested; `tsc` (frontend + backend) passes; migration applied on Supabase.
