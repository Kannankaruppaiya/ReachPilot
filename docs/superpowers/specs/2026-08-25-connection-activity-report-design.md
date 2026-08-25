# Connection-activity report + Excel export — design

**Date:** 2026-08-25
**Status:** design, awaiting approval
**Scope:** per-day LinkedIn connection activity for an account, downloadable as `.xlsx`

## Goal

For a LinkedIn account, answer per day:

- how many connection requests went out that day
- what the account's total connection count was at the START of the day
- what it is NOW
- how many were sent in total to date

…and let the user download the whole series as an Excel file.

## What the market does (research)

| Tool | Where the numbers come from |
|---|---|
| HeyReach, Expandi, Dripify | **Own campaign activity only** — requests sent / accepted / replied plus derived rates. Counters incremented at action time. Explicitly not real-time (replies lag "a few hours"). Export = date range + sender filter → CSV. |
| Waalaxy | The above **plus** an absolute "people in your network" figure, read periodically off LinkedIn's own network page. |
| LinkedIn official API | `r_1st_connections_size` returns `firstDegreeSize`. **Partner Program only** — not available to us. |

The reason these feel seamless is one design choice: **activity counters are written at the moment
the action happens; the absolute network number is snapshotted on a slow background timer.**
Nothing is scraped at report time.

We adopt the same split.

## Current state — verified against the live DB (2026-08-25)

Account `greatworksramesh@gmail.com` / `508cd4a6…`, workspace `2e27404a…`.

**Works today.** `daily_stats` (`workspace_id`, `linkedin_account_id`, `day`, `invites_sent`,
`emails_sent`, `accepted`, `replies`) is incremented at send time by `bumpSendStats`
(`server-v2/src/worker.ts:148`). Its numbers match `jobs` exactly — 15 invites recorded for
2026-08-25, 4 for 08-24, 3 for 08-20. This is already the HeyReach model and needs no change.

**Does not work today.** `accepted` and `replies` are `0` on every row, and all 196 leads in the
workspace are still `status='new'` after 159 sent invites. `linkedin_accounts.last_sync_at` is
2026-07-21. Two independent causes, both deliberate, neither a code defect:

1. `server-v2/.env` sets `LINKEDIN_SYNC_ENABLED=false`. The env doc explains why — the sync opens a
   real browser on a timer ("pages keep opening by themselves") and every extra automated session is
   avoidable account risk while testing. So locally the loop never starts.
2. **Production is the real blocker.** `LINKEDIN_DRIVER=remote`, and
   `RemoteAgentDriver.syncAccount` (`server-v2/src/modules/drivers/remote-agent.driver.ts:168`)
   returns an empty result — a hardcoded no-op. Its comment says sync "runs on the desktop agent's
   own timer". **That timer does not exist.** `desktop/main.js` polls `/api/agent/next-job` and
   posts `/api/agent/job-result`, nothing else; its `runJob` switch (`desktop/main.js:153`) has no
   sync case, so a sync job would return `unknown_action`. `AgentController` exposes only
   `account` / `next-job` / `job-result` — there is no endpoint a desktop-run sync result could be
   posted to.

Consequence: flipping `LINKEDIN_SYNC_ENABLED=true` in production changes nothing. The remote driver
swallows it.

**Never captured at all.** The account's absolute LinkedIn connection count. `syncAccount` visits
the LinkedIn connections page (`server-v2/src/modules/drivers/playwright-linkedin.driver.ts:1432`)
but only to match recent connections against pending invites — it never reads the "N connections"
figure.

## Consequence for ordering

The obvious plan — "add a connections read to `syncAccount`" — **cannot work in production until the
sync transport exists**, because in remote mode `syncAccount` is never called. So the snapshot work
depends on the transport work, and the export depends on neither.

Revised order:

```
Phase 1  Export endpoint + UI              (independent — ships on verified data)
Phase 2  Sync transport: remote → desktop  (unblocks everything acceptance-related)
Phase 3  Connection-count snapshot         (rides on Phase 2; fills the remaining columns)
```

## Phase 1 — export endpoint + UI

`GET /api/analytics/export?from=<ISO date>&to=<ISO date>` on the existing `AnalyticsController`
(`server-v2/src/modules/analytics/analytics.controller.ts`), authenticated the same way as its
siblings, workspace resolved from `req.workspaceId ?? user.workspaceId`.

`AnalyticsService.buildActivityReport(workspaceId, from, to)` reads inside a single `withWorkspace`
(all three tables are RLS'd):

- `daily_stats` — per-day `invites_sent`, `emails_sent`, `accepted`, `replies`
- `jobs` — per-day counts by status, and total still `scheduled`
- `linkedin_accounts` — timezone, warm-up limits, status

It returns plain rows; a separate `buildWorkbook(rows)` turns them into a `Buffer` using the `xlsx`
package already in `server-v2/package.json` (same usage as `server-v2/scripts/build-leads-xlsx.js`).
Keeping the two apart means the row logic is unit-testable without touching xlsx.

Response: the xlsx spreadsheet content type, with
`Content-Disposition: attachment; filename="reachpilot-<account>-<from>-<to>.xlsx"`.

Day bucketing uses the account's `timezone` (`Asia/Kolkata` here), not server local time, so a row
labelled 25 Aug means the IST day — matching what the user sees in the product.

Columns, and where each comes from:

| Column | Source | Phase |
|---|---|---|
| Date | series | 1 |
| Sent that day | `daily_stats.invites_sent` | 1 |
| Cumulative sent (day start) | running sum, exclusive | 1 |
| Cumulative sent (day end) | running sum, inclusive | 1 |
| Daily cap in force | warm-up calc for that day | 1 |
| Failed / deferred | `jobs` grouped by `last_error` | 1 |
| Queue remaining | `jobs.status='scheduled'` | 1 |
| Accepted | `daily_stats.accepted` | 2 |
| Replies | `daily_stats.replies` | 2 |
| Connections at day start | previous day's snapshot | 3 |
| Connections at day end | that day's snapshot | 3 |
| Gained that day | end minus start | 3 |

Phase-2/3 columns ship in Phase 1 as empty cells rather than being added later, so the sheet shape
never changes under the user.

UI: a date range plus a "Download report" control on `src/screens/Connections.tsx`, calling the
endpoint through the existing `src/lib/api/` client so the bearer token and refresh-on-401 are
handled.

## Phase 2 — sync transport: remote → desktop

The existing transport is already generic. `RemoteAgentDriver.pushAndWait` puts an arbitrary job
object on the account's Redis inbox; the desktop pops it, runs it, and posts the result back keyed
by token. Nothing about it is connect-specific. Making sync work is therefore small:

1. **Server** — replace the `syncAccount` / `withdrawStaleInvites` no-ops in `RemoteAgentDriver`
   with real dispatches over `pushAndWait`, mapping the agent's payload to `LinkedInSyncResult`
   (`accepted`, `replies`, optional `checkpoint` / `error`). A missing or malformed result maps to
   an empty result with `error` set — never a throw, so a sync failure cannot take the worker's sync
   loop down.
2. **Desktop** — add `sync_account` and `withdraw_stale_invites` cases to `runJob`
   (`desktop/main.js:153`). The driver methods themselves are already inside `driver.bundle.js`;
   they are simply unreachable.
3. **Ship** — per `DEPLOYMENT.md`, a driver/agent change requires rebuilding `desktop/agent/build.js`
   and reinstalling the desktop app. scp plus `pm2 restart` alone changes nothing at runtime.
4. **Enable** — `LINKEDIN_SYNC_ENABLED=true` with `LINKEDIN_SYNC_TICK_MS` left at its 45-minute
   default. `LINKEDIN_WITHDRAW_ENABLED` stays off until acceptance detection is observed working,
   because withdrawal is destructive — it can retract genuine human-sent invitations.

Account-safety note: this adds one browser session per sendable account per 45 minutes on the user's
own machine. That is precisely the cost the env flag was switched off to avoid, so it is a
deliberate re-enable, not an oversight.

## Phase 3 — connection-count snapshot

`PlaywrightLinkedInDriver.syncAccount` already loads the connections page. Read the "N connections"
figure there and return it as an optional `connectionsTotal?: number` on `LinkedInSyncResult`.
Optional, so a selector break degrades to "no snapshot today" rather than failing the whole sync —
this figure is LinkedIn-volatile in exactly the way `CLAUDE.md` warns about.

`LinkedInSyncService.apply()` writes it to a new `daily_stats.connections_total integer` column via
migration `0010`, following the `0009_account_ip.sql` pattern. Last write of the day wins.

Then "connections at day start" is the previous day's snapshot and "day end" is that day's, which is
what makes the two columns comparable without storing anything twice.

Two constraints, both from `CLAUDE.md`:

- The app DB role has no DDL rights. Migration `0010` must be applied by an admin; `npm run migrate`
  as `reachpilot` will not work.
- Rows written before the snapshot exists have `connections_total` NULL. The report must render
  those as blank, not `0` — a missing measurement is not a measurement of zero.

## Testing

Per `CLAUDE.md`, any suite that writes rows calls `assertLocalServices` in `beforeAll` and runs
against `.env.test`, never the production Supabase.

- `buildActivityReport` — fixture `daily_stats` plus `jobs` rows; assert per-day bucketing in a
  non-UTC timezone, cumulative-sum boundaries, and that a day with no activity still appears.
- `buildWorkbook` — parse the emitted buffer back with `xlsx` and assert headers and one row.
- `RemoteAgentDriver.syncAccount` — fake Redis; assert a well-formed result maps through, and that a
  timeout or malformed payload yields an empty result with `error` set rather than throwing.
- Snapshot — assert NULL renders blank and that day-start reads the previous day's value.

## Out of scope

Multi-account rollup, PDF/CSV variants, scheduled email delivery of the report, and any LinkedIn
Partner API integration.
