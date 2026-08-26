# Skip profiles we have already invited, on upload

**Date:** 2026-08-26
**Status:** approved, ready for planning

## Problem

Uploading a lead list queues every row, including people the account has already
sent a connection request to. Re-uploading the same spreadsheet re-sends to
everyone on it.

A duplicate guard exists in the scheduler, but it cannot fire for uploaded
lists. It matches on `lead_id`
([scheduler.service.ts:149](../../../server-v2/src/modules/engine/scheduler.service.ts)),
and jobs created from a spreadsheet carry `lead_id = null` — verified against the
live batch of 2026-08-25, where all 18 rows had no lead. So the only protection
against re-inviting someone is the operator remembering who is on the list.

Duplicate invites are not merely untidy. LinkedIn counts every invite against a
weekly cap, so a re-send spends allowance that a genuinely new prospect needed,
and repeatedly inviting the same member is exactly the pattern automation
detection looks for.

## What "already invited" means

Only `connect_request` jobs with `status = 'sent'`.

Queued-but-unsent rows are deliberately NOT matched. The consequence is explicit:
uploading a second list while the first is still draining can queue the same
person twice, and both will send. The safe habit is to clear the queue before
uploading. Failed rows are also not matched — a failure is often a bad network
window rather than a verdict about the person, and permanently excluding those
would quietly bury recoverable leads.

## Matching

### The key

LinkedIn identifies a member two ways in URLs: an obfuscated member URN
(`/in/ACwAADY3WCIB…`) and a human-readable vanity slug (`/in/john-doe`). Scraped
lists carry both, mixed, so raw string comparison is not enough.

`profileKey(url)` reduces a URL to the `/in/<slug>` identity:

| input | key |
|---|---|
| `https://www.linkedin.com/in/ACwAADY3WCIB/` | `acwaady3wcib` |
| `linkedin.com/in/John-Doe?utm_source=x` | `john-doe` |
| `https://in.linkedin.com/in/john-doe` | `john-doe` |
| `https://example.com/foo` | `null` |

It normalises protocol, `www` and country subdomains, case, percent-encoding,
trailing slash, query and fragment. A URL with no `/in/` segment returns `null`.

### Cross-form matches

A key alone cannot tell that `/in/ACwAADY3WCIB` and `/in/john-doe` are the same
person. Resolving that at upload time would mean loading one profile per row —
for a 100-row list, a hundred page loads that produce nothing a prospect ever
sees. That is both slow and precisely the traffic shape that gets an account
challenged, so we do not do it.

Instead we record the answer at the moment we already have it, for free. When a
connect succeeds the driver has read the landed URL and knows the real vanity
slug ([playwright-linkedin.driver.ts](../../../server-v2/src/modules/drivers/playwright-linkedin.driver.ts),
`landedUrl` / `slugOf`). Returning that as `resolvedSlug` on
`LinkedInActionResult` lets the worker store it, so every sent job carries BOTH
keys and future uploads match either form.

This makes the dedupe progressively complete rather than complete on day one:
the 159 invites already sent have no resolved slug and will only match on the
form they were sent with. That is an accepted limit, not a gap to fill — a
backfill would cost the same hundred page loads we just refused.

### Where the resolved slug lives

Merged into the existing `jobs.payload` JSON, as `resolvedSlug`.

Not a new column: the application database role has no DDL rights (see
CLAUDE.md), so a migration is not available to this codebase.

## Flow

In `createBatch` ([jobs.service.ts](../../../server-v2/src/modules/jobs/jobs.service.ts)),
before any row is inserted:

1. Read every `connect_request` job in the workspace with `status = 'sent'`,
   selecting `payload` only.
2. Build a `Set` of keys: `profileKey(payload.target)` plus
   `profileKey(payload.resolvedSlug)` where present.
3. Partition the uploaded rows into kept and skipped. A row is skipped when its
   key is in the set, or when an earlier row in the same file had the same key.
4. Insert jobs for the kept rows only, exactly as today.

Rows whose URL yields a `null` key are KEPT, never skipped. Silently discarding
input we could not classify would hide a malformed spreadsheet; a kept row fails
later with a reason the operator can read.

## Interface

`createBatch` returns `skipped` alongside its existing fields:

```ts
{ batchId, total, today, queuedDays, skipped }
```

`total` stays the number of jobs actually created, so existing callers keep their
meaning.

When every row is skipped, no batch is created and `createBatch` returns
`{ total: 0, skipped: N }` rather than throwing. Uploading a list of people you
have already contacted is a normal outcome, not an error — the current
`BadRequestException` for an empty input must not be reached by that path.

The UI reports all three numbers:

> 106 uploaded · 88 already contacted, skipped · 18 queued (5 today)

The activity log line gains the same count.

## Testing

Two pure functions, tested without a database or a browser, matching the pattern
used by the other fixes landed on 2026-08-26:

- `profileKey(url)` — each normalisation above, plus `null` for non-profile URLs.
- `selectNewRows(rows, sentKeys)` — returns kept and skipped; covers a row
  already sent, a duplicate within the file, an unparseable URL being kept, and
  the every-row-skipped case.

`resolvedSlug` capture is covered where the driver's other outcome mapping is.

## Out of scope

- Matching on name or company. Fuzzy identity matching can suppress a real
  prospect who happens to share a name, and a missed duplicate is much cheaper
  than a silently dropped lead.
- Backfilling resolved slugs for the 159 already-sent invites.
- Deduping against queued or failed jobs.
