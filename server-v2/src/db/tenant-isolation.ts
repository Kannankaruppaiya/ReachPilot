import { Kysely, sql } from 'kysely';

/**
 * Is tenant isolation actually in force on this connection?
 *
 * 🔴 It was not, and nothing noticed. Measured 2026-08-27 against the production
 * database: every tenant table had RLS enabled, FORCE ROW LEVEL SECURITY set and a
 * policy attached, `withWorkspace` set the GUC correctly, and
 * `current_workspace_id()` returned the right uuid — yet four different workspaces
 * each counted the same 370 jobs, identical to an unscoped read.
 *
 * The cause was the connecting ROLE: the app connects as `postgres`, which carries
 * `rolbypassrls`. Postgres skips every policy for such a role — FORCE RLS does not
 * override BYPASSRLS, it only stops a table's OWNER from bypassing. So the schema
 * looked perfect while isolation was off, and a cross-tenant read or write would
 * have succeeded silently.
 *
 * That is the failure mode worth guarding: not "is RLS configured" — it was — but
 * "does it actually bite for the identity we connect with". This module answers the
 * second question, so the invariant is CHECKED at boot rather than assumed.
 */

/** What we observe about the live connection. Kept plain so the verdict is pure. */
export interface IsolationFacts {
  role: string;
  bypassrls: boolean;
  tables: { name: string; rlsEnabled: boolean; forced: boolean; policies: number }[];
}

export interface IsolationVerdict {
  isolated: boolean;
  reason: string;
}

/** Tenant tables whose policies are load-bearing. Not exhaustive — a representative
 *  set is enough to catch a database-wide misconfiguration. */
export const TENANT_TABLES = ['jobs', 'leads', 'campaigns', 'memberships'];

/**
 * Decide whether this connection is genuinely isolated.
 *
 * Order matters: BYPASSRLS is checked FIRST because it makes every other signal
 * meaningless. A table can be flawlessly configured and still return every
 * tenant's rows.
 */
export function isolationVerdict(facts: IsolationFacts): IsolationVerdict {
  if (facts.bypassrls) {
    return {
      isolated: false,
      reason:
        `connected as "${facts.role}", which has BYPASSRLS — Postgres skips every ` +
        `policy for this role, so RLS is inert no matter how the tables are configured`,
    };
  }

  // Observing nothing is not an all-clear. A probe that matched no tables (schema
  // renamed, wrong search_path, permissions) would otherwise sail through every
  // remaining check and report isolation that was never verified.
  if (facts.tables.length < TENANT_TABLES.length) {
    const missing = TENANT_TABLES.filter((n) => !facts.tables.some((t) => t.name === n));
    return {
      isolated: false,
      reason: `could not observe ${missing.length ? missing.join(', ') : 'the tenant tables'} — isolation unverified, not assumed`,
    };
  }

  const unprotected = facts.tables.filter((t) => !t.rlsEnabled || t.policies === 0);
  if (unprotected.length) {
    return {
      isolated: false,
      reason: `no effective RLS on: ${unprotected.map((t) => t.name).join(', ')}`,
    };
  }

  // A table's OWNER bypasses its own policies unless FORCE is set — the one case
  // FORCE actually exists for.
  const unforced = facts.tables.filter((t) => !t.forced);
  if (unforced.length) {
    return {
      isolated: false,
      reason:
        `FORCE ROW LEVEL SECURITY missing on: ${unforced.map((t) => t.name).join(', ')} ` +
        `(the table owner bypasses its own policies without it)`,
    };
  }

  return { isolated: true, reason: `role "${facts.role}" is subject to RLS on all checked tables` };
}

/** Read the facts off the live connection. Read-only. */
export async function readIsolationFacts(db: Kysely<any>): Promise<IsolationFacts> {
  const who: any = (
    await sql`select current_user as role,
                     coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) as bypassrls`.execute(
      db,
    )
  ).rows[0];

  const rows: any[] = (
    await sql`select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
                     (select count(*) from pg_policies p where p.tablename = c.relname) as policies
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = any(${TENANT_TABLES})`.execute(db)
  ).rows;

  return {
    role: String(who.role),
    bypassrls: !!who.bypassrls,
    tables: rows.map((r) => ({
      name: String(r.name),
      rlsEnabled: !!r.rls,
      forced: !!r.forced,
      policies: Number(r.policies || 0),
    })),
  };
}

/**
 * Boot-time gate.
 *
 * Logs loudly by default rather than refusing to start: isolation has been off for
 * the whole life of this deployment, so failing closed today would take the app
 * down instead of protecting anything. Set `REQUIRE_TENANT_ISOLATION=true` once the
 * app connects as a non-BYPASSRLS role — from then on a regression (someone points
 * DATABASE_URL back at `postgres`) stops the process instead of silently
 * un-isolating every tenant.
 */
export async function assertTenantIsolation(
  db: Kysely<any>,
  log: { warn: (m: string) => void; log: (m: string) => void } = console,
): Promise<IsolationVerdict> {
  let verdict: IsolationVerdict;
  try {
    verdict = isolationVerdict(await readIsolationFacts(db));
  } catch (err: any) {
    verdict = { isolated: false, reason: `could not verify isolation: ${err.message}` };
  }

  if (verdict.isolated) {
    log.log(`Tenant isolation verified — ${verdict.reason}`);
    return verdict;
  }

  const message = `TENANT ISOLATION IS NOT IN FORCE — ${verdict.reason}. Cross-tenant reads and writes will succeed.`;
  if (process.env.REQUIRE_TENANT_ISOLATION === 'true') throw new Error(message);
  log.warn(message);
  return verdict;
}
