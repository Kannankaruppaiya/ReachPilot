# workspace-automation-settings — Tasks

## DB
- [ ] `migrations/0004_workspace_settings.sql` — table + CHECKs + RLS (ENABLE+FORCE+policy) + seed per workspace.
- [ ] `src/db/types.ts` — add `WorkspaceSettingsTable` row type to `DatabaseSchema`.
- [ ] Run `npm run migrate` against Supabase; verify the table + seeded rows.

## Backend services
- [ ] `WorkspaceSettingsService` — `get`, `update` (validate + audit), `validate`.
- [ ] `AutomationPolicyService` — `getSettings` (15s cache), `isWorkingDay`, `withinHours`,
      `nextWindowStartUtc`, `interactionGapMs`, `effectiveDailyLimit` (pure helpers).
- [ ] Refactor `PacingService.checkPacingAndRegister` + `release` to read settings via
      `AutomationPolicyService` (working days, hours, tz, daily conn/invite/message limits,
      weekly cap, spacing, warm-up). New invite/message Redis counters.
- [ ] Register services in the owning Nest module(s); wire DI.

## API
- [ ] `WorkspaceSettingsController` — `GET`/`PUT /api/workspace/settings`, `GET .../status`.
- [ ] User-safe validation messages; `withWorkspace` everywhere.

## Frontend
- [ ] `@/types` — `WorkspaceSettings`, `WorkspaceSettingsStatus`.
- [ ] `@/lib/api` — `getWorkspaceSettings`, `saveWorkspaceSettings`, `getSettingsStatus`.
- [ ] `@/constants` — field bounds + working-day labels.
- [ ] Settings → **Automation** tab (all fields, validation, load current, save, responsive).
- [ ] Dashboard — "Automation status" card (hours, today's counts, remaining, next run).

## Audit
- [ ] `settings.update` audit row with `{before, after}`, user, workspace (in the service).

## Tests
- [ ] Unit: `AutomationPolicyService` (hours boundary, overnight, working-day/weekend, tz,
      daily-limit→next-day, spacing, warm-up ramp, midnight reset).
- [ ] Unit: `WorkspaceSettingsService.validate` (bad time range, empty days, bad tz, min>max).

## Verify
- [ ] `tsc --noEmit` backend + frontend; `npm run lint`.
- [ ] Manual: change a setting → confirm pacing/scheduler/dashboard/API reflect it (no restart).
- [ ] Tick AC1–AC11 in requirements.md.
