# auth-session-reliability — Requirements

- **Status:** Ready to build
- **Priority:** P0
- **Related:** ADR-000x (to be written on decision), `src/lib/api/`, `server-v2/src/modules/auth/`

## Problem

Users are unexpectedly logged out during normal use — most visibly when they change
their LinkedIn limits in Settings, but really whenever the 15-minute access token
expires and several requests fire at once. This erodes trust in a product whose whole
value is "set it and let it run."

## Root cause (already diagnosed)

Refresh tokens are **single-use with rotation** — `AuthService.refresh()` revokes the
current session and issues a new refresh token on every use. The frontend `tryRefresh()`
(`src/lib/api/`) has **no single-flight lock**, so when the access token has expired and
multiple requests 401 at the same time (the 60s shell poller fires two, Settings mount
fires more), each calls `tryRefresh()` with the same stored refresh token. The first
succeeds and rotates the token; the others send the now-revoked token → 401
"Invalid refresh token" → `auth.clear()` → logout.

## User stories

1. As a user, I stay logged in while working, even if I leave a page open past the
   access-token lifetime, so I never lose my place mid-task.
2. As a user, a transient network blip or API hiccup does not log me out.
3. As a user, saving LinkedIn limits never logs me out.
4. As a security-conscious operator, a genuinely invalid/expired/revoked session still
   logs the user out (we don't weaken real auth to fix the race).

## Acceptance criteria (EARS)

- **AC1** — WHEN two or more requests receive a 401 at the same time and a valid refresh
  token exists, the system SHALL perform **at most one** refresh call and have all waiting
  requests reuse its result.
- **AC2** — WHEN the access token has expired but the refresh token is still valid, the
  system SHALL transparently refresh and retry the original request(s) without logging out.
- **AC3** — IF a refresh attempt fails with a definitive **401/403** (rejected), THEN the
  system SHALL clear tokens and route to login.
- **AC4** — IF a refresh attempt fails due to **network error or 5xx** (unavailable), THEN
  the system SHALL keep the tokens and surface a transient error, NOT log out.
- **AC5** — WHILE a refresh is in flight, any new request that hits 401 SHALL await the
  same in-flight refresh rather than starting another.
- **AC6** — WHEN limits are saved on the Settings screen after the access token expired,
  the system SHALL complete the save (after a single silent refresh) and keep the session.
- **AC7** — The change SHALL NOT lengthen the access-token lifetime as the fix, and SHALL
  keep refresh-token rotation (no reuse of a revoked token beyond the agreed grace).

## Non-goals

- Redesigning the auth scheme (keep JWT access + rotating refresh).
- Replacing the 60s poll with realtime (tracked separately in the roadmap; it would
  reduce, but not fix, the race).

## Definition of done

- All ACs met; a reproduction (two concurrent 401s after expiry) no longer logs out.
- Covered by an automated test (unit for the client single-flight; ideally an E2E that
  expires the token and drives a concurrent action).
