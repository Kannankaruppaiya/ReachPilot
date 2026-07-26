# auth-session-reliability — Tasks

Work top-down; tick `[x]` as you go. Each task is small and verifiable.

## Client (primary fix)

- [ ] In `src/lib/api/index.ts`, change `tryRefresh()` to return a tri-state
      `'ok' | 'rejected' | 'unavailable'` (401/403 → rejected; network/5xx → unavailable).
- [ ] Add a module-level `refreshInFlight` promise + `refreshOnce()` wrapper (single-flight).
- [ ] Update `req()`: on 401, `await refreshOnce()`; retry on `ok`; `auth.clear()` + route
      to login only on `rejected`; throw a transient error on `unavailable` (keep tokens).
- [ ] Ensure the retried request uses the newly stored access token (re-read from storage).
- [ ] Manually verify: expire the access token, trigger a concurrent action, confirm one
      `/auth/refresh` in the network tab and no logout.

## Server (defense-in-depth grace)

- [ ] Decide Option A (rotated-session link) vs Option B (time grace); record as an ADR.
- [ ] (Option A) Migration: add `rotated_at`, `replaced_by` to `user_sessions`
      (apply via an admin/superuser role — app user has no DDL rights).
- [ ] Update `AuthService.refresh()` to honor the grace: a token revoked within N seconds
      and linked to a still-valid child returns the child's current tokens instead of 401.
- [ ] Add `AUTH_REFRESH_GRACE_MS` (or reuse-window) to `.env` + `.env.example` + config schema.

## Tests

- [ ] Unit: N concurrent 401'd `req()` calls → exactly one refresh, all succeed.
- [ ] Unit: refresh 401 → tokens cleared; refresh 500 → tokens kept.
- [ ] Unit (server): concurrent refresh within grace → both succeed; outside grace → one 401.
- [ ] E2E (Playwright): short-TTL login → save limits while poller ticks → still logged in.

## Wrap-up

- [ ] Update `CLAUDE.md` (auth section) and remove the "logout bug known-unfixed" note
      from memory once shipped.
- [ ] Verify all acceptance criteria AC1–AC7 in `requirements.md`.
