import { Kysely, sql } from 'kysely';

// Is tenant isolation in force for the role we connect as? RLS can be fully
// configured and still bypassed: a role with BYPASSRLS skips every policy (FORCE
// RLS only stops table owners). So this is checked at boot, not assumed.

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

/** A representative set of tenant tables; enough to catch a database-wide misconfiguration. */
export const TENANT_TABLES = ['jobs', 'leads', 'campaigns', 'memberships'];

/** Is this connection isolated? BYPASSRLS is checked first: it overrides everything else. */
export function isolationVerdict(facts: IsolationFacts): IsolationVerdict {
  if (facts.bypassrls) {
    return {
      isolated: false,
      reason:
        `connected as "${facts.role}", which has BYPASSRLS — Postgres skips every ` +
        `policy for this role, so RLS is inert no matter how the tables are configured`,
    };
  }

  // Observing no tables is not an all-clear (renamed schema, wrong search_path).
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

  // Without FORCE, a table's owner bypasses its own policies.
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
 * Boot-time check. Logs by default; set `REQUIRE_TENANT_ISOLATION=true` once the
 * app connects as a non-BYPASSRLS role, so a regression stops the process.
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
