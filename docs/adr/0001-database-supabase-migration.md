# 0001 — Migrate database to Supabase (session pooler)

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

Development ran against a local PostgreSQL 18 instance (user `reachpilot`) whose
schema was applied by an admin — the app DB user has no DDL rights. We wanted a
clean, fresh database for a from-scratch signup/onboarding run without destroying
the existing local data.

Key constraints of the codebase:

- Every tenant table uses **FORCE ROW LEVEL SECURITY**. The app sets the tenant
  via `SET LOCAL app.workspace_id` inside a transaction (`withWorkspace`). RLS
  policies read that GUC through `current_workspace_id()`.
- Migrations are portable: no hardcoded roles, `GRANT`s, or `OWNER` statements —
  they only need a connecting role that can `CREATE` tables/types/functions/policies.

## Decision

Point `DATABASE_URL` at a **fresh Supabase project**, keeping the old local
connection string commented out (data preserved, untouched). Apply the schema
with `npm run migrate` against Supabase.

Connection choices that matter:

1. **Session pooler (or direct), NOT the transaction pooler (:6543).**
   The app relies on `SET LOCAL` within a transaction for RLS. Transaction-mode
   pooling breaks session-scoped state and prepared-statement assumptions. The
   session pooler is also IPv4-friendly, which the direct (IPv6-default)
   connection is not on typical home networks.
2. **SSL is required.** Append `?sslmode=require`, or `?sslmode=no-verify` when
   the CA chain isn't trusted by the local Node/`pg` setup.
3. **Percent-encode the password** in the URL (e.g. `@` → `%40`).

## Consequences

- The Supabase `postgres` role has `rolbypassrls = true`. RLS is effectively
  bypassed for the app's own connection, so `withWorkspace`'s `SET LOCAL` is a
  harmless no-op and the "reads return 0 rows" RLS gotcha does not bite. This is
  fine for single-tenant/early use but means tenant isolation is **not** enforced
  at the DB layer under this role — revisit with a non-BYPASSRLS role before
  multi-tenant production.
- The migration runner and Kysely pool read SSL only from the connection string
  (no separate SSL config), so the `sslmode` query param is the single control point.
- Old local Postgres remains available; switching back is a one-line `.env` change.
- Never commit the real connection string — it carries the DB password. Only
  `server-v2/.env.example` (placeholders) is tracked.
