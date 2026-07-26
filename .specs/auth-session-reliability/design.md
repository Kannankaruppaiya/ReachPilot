# auth-session-reliability — Design

## Overview

Fix the logout race primarily on the **client** with a single-flight refresh, and add a
small **server-side grace** so a brief burst of concurrent refreshes with the same token
can't hard-fail. Keep rotation and short access tokens.

## Current behaviour (recap)

- `src/lib/api/index.ts` → `req()` on 401 calls `tryRefresh()` per request; on failure
  `auth.clear()` + throw. No coordination between concurrent callers.
- `server-v2/src/modules/auth/auth.service.ts` → `refresh()` looks up the session by
  `refresh_token_hash WHERE revoked_at IS NULL`, **revokes it**, and issues a new pair.
  A second use of the same (now revoked) token → `UnauthorizedException`.

## Approach

### 1. Client single-flight refresh (primary fix — AC1, AC2, AC5)

Hold a module-level promise so only one refresh runs at a time; all 401'd requests await it.

```ts
let refreshInFlight: Promise<boolean> | null = null

function refreshOnce(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = tryRefresh().finally(() => { refreshInFlight = null })
  }
  return refreshInFlight
}
```

`req()` calls `await refreshOnce()` instead of `tryRefresh()` directly. After it resolves
true, requests retry with the freshly stored access token; the token is rotated exactly
once for the whole burst.

### 2. Distinguish "rejected" vs "unavailable" (AC3, AC4)

`tryRefresh()` must return a **tri-state**, not a bool that conflates causes:

- `rejected` — response status is **401/403** → `auth.clear()` + route to login.
- `unavailable` — network error or **5xx** → keep tokens, throw a transient error.
- `ok` — new tokens stored.

Only `rejected` clears tokens. (This matches the earlier `tryRefresh` hardening noted in
memory: don't log out on network blips.)

### 3. Server-side refresh grace (defense-in-depth — AC7 bounded)

Allow a **short reuse window** so a legitimate concurrent burst doesn't hard-fail if the
client single-flight is ever bypassed (e.g. two tabs):

- Option A (chosen): when a refresh token is presented and its session was revoked
  **within the last N seconds** (e.g. 10s) **and** replaced by a still-valid child session,
  return the child's current tokens instead of 401. Requires linking rotated sessions
  (`replaced_by` / `rotated_at` columns) — a small migration.
- Option B (simpler, weaker): keep the just-revoked token valid for a `GRACE_MS` window.

Prefer A for auditability; B is acceptable as a first cut if migration cost is a concern.

## Data / schema

For Option A, add to `user_sessions`: `rotated_at TIMESTAMPTZ NULL`, `replaced_by UUID NULL`.
`user_sessions` is **not RLS'd**, so this is a plain migration — but remember the app DB
user has no DDL rights (an admin/superuser applies it; on Supabase the `postgres` role can).

## Sequence (concurrent 401 burst, after fix)

```
Req A (401) ─┐
Req B (401) ─┼─▶ refreshOnce() ──▶ POST /auth/refresh ──▶ new pair stored
Req C (401) ─┘        (B, C await the same promise)
   then A, B, C retry with the new access token → 200
```

## Edge cases

- Refresh token missing entirely → no refresh, route to login (unchanged).
- Refresh returns 5xx mid-burst → all awaiters get "unavailable", tokens kept, surfaced
  as a transient toast; next user action retries.
- Two browser tabs → client single-flight is per-tab; the server grace (§3) covers cross-tab.
- Logout during an in-flight refresh → clear tokens; the resolved refresh is ignored.

## Alternatives considered

- **Lengthen access-token TTL** — masks the race, weakens security. Rejected (AC7).
- **Drop rotation (long-lived refresh)** — removes the race but loses rotation's theft
  detection. Rejected.
- **Only client fix, no server grace** — sufficient for single-tab; multi-tab can still
  race. Acceptable MVP, but §3 is the robust finish.

## Test strategy

- Unit: mock `fetch`; fire N concurrent `req()` calls that 401 once, assert exactly one
  `/auth/refresh` call and all N succeed on retry.
- Unit: refresh returns 401 → tokens cleared; returns 500 → tokens kept.
- E2E (Playwright): log in, force access-token expiry (short TTL env or clock), trigger a
  concurrent action (save limits while poller runs), assert still logged in.
