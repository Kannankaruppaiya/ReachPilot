import { Client } from 'pg';

/**
 * Connection string for a role subject to RLS. The local test user is a superuser,
 * which bypasses RLS like production's role, so suites that must prove "works
 * under RLS" connect as this one. Idempotent; needs CREATE ROLE rights, throws
 * otherwise so the caller can skip.
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
