# Tenant isolation — the real fix

## What was wrong

Measured against the production database on 2026-08-27:

```
connected as : {"current_user":"postgres","bypassrls":true,"superuser":false}

table         rls_enabled  rls_forced  owner     policies
  campaigns   true         true        postgres  1
  jobs        true         true        postgres  1
  leads       true         true        postgres  1
  memberships true         true        postgres  2

withWorkspace(Kannan's Workspace)  guc + current_workspace_id() correct, jobs = 370
withWorkspace(RJP's Workspace)     guc + current_workspace_id() correct, jobs = 370
raw getDb() (no workspace context)                                       jobs = 370
```

Every signal the codebase relies on looked healthy — RLS enabled, `FORCE ROW LEVEL
SECURITY` set, policies attached, the GUC arriving, `current_workspace_id()`
returning the right uuid — while four different workspaces read each other's rows.

**The cause is the connecting role.** The app connects as `postgres`, which carries
`rolbypassrls`. Postgres skips policy evaluation entirely for such a role.
`FORCE ROW LEVEL SECURITY` does **not** override this — it only stops a table's
*owner* from bypassing its own policies. So the schema was never the problem, and
no amount of policy work would have fixed it.

Practical consequence: `withWorkspace` has been decorative. A cross-tenant read or
write would have succeeded silently, and the worker's scheduler tick — which
enumerates every workspace — was draining one shared row set four times over.

## The fix: connect as a role that is subject to RLS

Run in the Supabase SQL editor (or any `postgres` session). **Review before
running** — it creates a role and grants; it changes nothing about the data.

```sql
-- 1. A dedicated application role. No BYPASSRLS, no superuser, not a table owner.
CREATE ROLE reachpilot_app LOGIN PASSWORD 'CHANGE_ME_STRONG';

-- 2. Only the rights the app actually needs.
GRANT USAGE ON SCHEMA public TO reachpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reachpilot_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reachpilot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reachpilot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO reachpilot_app;

-- 3. Prove it is NOT exempt. Both must come back false.
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'reachpilot_app';
```

Then point the app at it and re-run the probe:

```
DATABASE_URL=postgresql://reachpilot_app:<password>@<host>:<port>/postgres
```

```bash
npx ts-node -r tsconfig-paths/register scripts/_probe-rls.ts
```

Expected after the change: the two `withWorkspace` counts differ from each other
and from the unscoped read.

### Then turn the guard from a warning into a wall

```
REQUIRE_TENANT_ISOLATION=true
```

`assertTenantIsolation` runs at API and worker boot. Today it only WARNS, because
isolation has been off for the life of this deployment and failing closed would
take the app down rather than protect anything. Once the app connects as
`reachpilot_app`, set the flag: a regression (someone points `DATABASE_URL` back at
`postgres`) then stops the process instead of silently un-isolating every tenant.

## Things to check while switching

- **Migrations.** `reachpilot_app` deliberately has no DDL rights. Keep running
  migrations as `postgres`, exactly as today.
- **Login's chicken-and-egg.** `memberships` is RLS'd, so login cannot read it
  without a workspace context; `AuthService.findMembership()` scans workspaces.
  Under a role that is genuinely subject to RLS this scan will start returning
  nothing. That path needs a `SECURITY DEFINER` helper or a narrow policy keyed on
  the authenticated user — **verify login before switching production over.**
- **Cross-tenant readers.** Anything that legitimately spans tenants (inbox sync,
  the scheduler's workspace enumeration) must keep enumerating `workspaces` — which
  is not RLS'd — and then call `withWorkspace` per tenant. That pattern still works.
- **The `postgres` connection string is a superuser-adjacent credential.** Once the
  app no longer needs it, rotate it.

## Why the check lives in code

`src/db/tenant-isolation.ts` asks the one question the schema could not answer:
does RLS actually bite for the identity we connect with? The verdict deliberately
judges `BYPASSRLS` **before** any table configuration, because a flawless schema
otherwise reports a false all-clear — which is exactly what happened here. It also
refuses to pass when it observed no tables: an unverified check must never read as
a clean one.

Covered by `test/tenant-isolation.spec.ts`.
