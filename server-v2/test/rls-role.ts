import { Client } from 'pg';

/**
 * A connection string for a role that is SUBJECT to row-level security.
 *
 * The local test database is created with POSTGRES_USER=reachpilot, which the
 * postgres image makes a superuser — and a superuser bypasses RLS just like the
 * production `postgres` role (BYPASSRLS) does. Code that forgot `withWorkspace`
 * therefore passes every test while being broken for any role that RLS applies
 * to (docs/TENANT_ISOLATION.md). Suites that need to prove "works under RLS"
 * connect through this role instead.
 *
 * Idempotent. Needs a connection allowed to CREATE ROLE and GRANT (the local
 * superuser); throws otherwise so the caller can skip.
 */
export const RLS_ROLE = 'rp_rls_probe';

export async function rlsRoleUrl(adminUrl: string): Promise<string> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
          CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_ROLE}' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
    `);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.username = RLS_ROLE;
  url.password = RLS_ROLE;
  return url.toString();
}
