# linkedin-driver-hardening — Design

## Overview

Harden the existing `PlaywrightLinkedInDriver` rather than rewrite it: lock in the safety
mechanisms already discovered, validate the unproven selectors against a throwaway account,
and make every failure mode degrade to "pause + notify, no retry" instead of hammering.

## Components touched

- `server-v2/src/modules/drivers/playwright-linkedin.driver.ts` — actions + selectors +
  session bootstrap + route-abort + shared cooldown stamp.
- `warmup-browse.service.ts`, `linkedin-sync.service.ts` — honor the shared cooldown.
- `linkedin-selectors.ts` — the selector cascades (kept in one place).
- `scripts/verify-linkedin.ts` — the idempotent live-verification harness.

## Design details

### Element scoping (AC1)
Anchor every top-card action to the `<h1>`'s nearest ancestor that contains an action
button; never search page-wide or across `<main>`. Detect degree by visible text ("· 1st"),
not by the removed `.dist-value`/`.distance-badge` classes. Dropdown items are scoped to the
open menu only.

### Custom-invite navigation guard (AC2)
Register `page.route('**/preload/custom-invite/**', route => …)`:
- IF `route.request().isNavigationRequest()` AND it's the main frame → `route.abort()`
  (this is the request that loops and corrupts cookies).
- ELSE → `route.continue()`.
LinkedIn's in-app onClick (no document request) then opens the composer in-page. Do **not**
use a capture-phase `preventDefault` — it also cancels LinkedIn's handler and the composer
never opens.

### Session ownership & bootstrap (AC3)
`openAccountContext` reuses the persistent profile's own cookies and injects nothing. With
`requireSession` (true for every path except `login()`), if the profile has no `li_at` it
throws `SESSION_MISSING` **before** navigating. The worker maps that to
status=`disconnected` + reconnect notification and holds the job with no retry. A dead
cookie that bounces to `/login` is treated the same.

### Checkpoint handling (AC4)
After navigation, detect challenge/checkpoint URLs and DOM markers. On hit: set account
`checkpoint`/`paused`, notify, hold job. `buildActionContext` already returns null for
checkpoint/paused/disconnected accounts — keep that gate as the belt-and-suspenders.

### Shared cross-loop cooldown (AC5)
One Redis key per account `linkedin:browser:last:<acct>` (`BROWSER_LAST_KEY`), stamped in
`openAccountContext` on **every** open. Non-action loops (warm-up browse `runOne`, sync
`syncAll` per account) skip if a session happened within `BROWSER_SESSION_COOLDOWN_MS`
(~5 min). Actions keep their own 6–14 min pacing and are the priority path — warm-up/sync
only run in genuine idle windows so sessions never stack.

### Selector validation & safe degradation (AC6)
For each of sync (acceptance/reply detection), withdraw-stale-invites, and engagement
(follow/visit/like/endorse): define a **cascade** (most-robust role/text selector →
fallbacks). If none match, **log and skip** — never fall through to a broad match that
could act on the wrong element. Validate each against a throwaway account, ONE run at a
time (≥30–60 min rest between runs — live scripts bypass pacing and rate-limit the account).

### Stealth (AC7)
Apply `playwright-extra` + stealth plugin at context creation (behind a `STEALTH_ENABLED`
env): mask `navigator.webdriver`, normalize WebGL/canvas/UA-CH fingerprints.

## Sequence — a connect job (hardened)

```
scheduler → job → buildActionContext (health gate) → openAccountContext
  ├─ requireSession? no li_at → throw SESSION_MISSING → disconnect+notify, no retry
  ├─ stamp linkedin:browser:last  (blocks warm-up/sync stacking)
  ├─ route('**/preload/custom-invite/**') installed
  ├─ goto /in/<slug>  (checkpoint check → pause+notify if hit)
  └─ scope to h1 top card → click Connect (or More→Connect, in-app) → send → outcome enum
```

## Edge cases

- Connect already pending / already connected → map to the outcome enum, don't re-invite.
- Wrong-person guard: if the scoped top card's name doesn't match the target, abort the action.
- Selector drift mid-run → skip that action, surface a "selectors may have changed" signal.

## Test strategy

- `scripts/verify-linkedin.ts` (idempotent) against a throwaway account, one run at a time.
- Unit-test the outcome-enum mapping and the route-abort predicate in isolation.
- Regression: assert the custom-invite route-abort fires and the composer still opens.
