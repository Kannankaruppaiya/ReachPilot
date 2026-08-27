/**
 * Read-only: why does `withWorkspace` not isolate?
 *
 * Observed 2026-08-27: four different workspaces each report an identical
 * `unlinked=366 sent=205` for connect jobs — i.e. every workspace scan returns the
 * same rows. Four causes produce that symptom and they need different fixes, so
 * measure which one it is instead of assuming:
 *
 *   1. the connecting role has BYPASSRLS       -> policies are skipped entirely
 *   2. the role owns the table + no FORCE RLS  -> owner bypasses its own policies
 *   3. RLS not enabled / no policy on the table
 *   4. the GUC never arrives (pooling, SET LOCAL outside a transaction)
 *
 * Writes nothing.
 */
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
const { sql } = require('kysely');

const TABLES = ['jobs', 'leads', 'campaigns', 'memberships'];

(async () => {
  const db: any = getDb();

  const who = (
    await sql`select current_user, session_user,
                     (select rolbypassrls from pg_roles where rolname = current_user) bypassrls,
                     (select rolsuper     from pg_roles where rolname = current_user) superuser`.execute(db)
  ).rows[0];
  console.log('connected as :', JSON.stringify(who));

  console.log('\ntable                 rls_enabled  rls_forced  owner            policies');
  const t = (
    await sql`select c.relname, c.relrowsecurity, c.relforcerowsecurity,
                     pg_get_userbyid(c.relowner) owner,
                     (select count(*) from pg_policies p where p.tablename = c.relname) policies
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = any(${TABLES})
               order by c.relname`.execute(db)
  ).rows as any[];
  for (const r of t) {
    console.log(
      `  ${String(r.relname).padEnd(20)} ${String(r.relrowsecurity).padEnd(12)} ${String(r.relforcerowsecurity).padEnd(11)} ${String(r.owner).padEnd(16)} ${r.policies}`,
    );
  }

  // Does the GUC actually arrive inside the wrapper, and does the helper read it?
  const workspaces = (await db.selectFrom('workspaces').select(['id', 'name']).execute()) as any[];
  if (workspaces.length >= 2) {
    const [a, b] = workspaces;
    for (const ws of [a, b]) {
      const seen = await withWorkspace(ws.id, async (tx: any) => {
        const guc = (await sql`select current_setting('app.workspace_id', true) g`.execute(tx)).rows[0].g;
        let fn: string | null = null;
        try {
          fn = (await sql`select current_workspace_id()::text f`.execute(tx)).rows[0].f;
        } catch (e: any) {
          fn = `ERR: ${String(e.message).slice(0, 40)}`;
        }
        const n = (await sql`select count(*)::int n from jobs`.execute(tx)).rows[0].n;
        return { guc, fn, jobs: n };
      }).catch((e: any) => ({ err: e.message }));
      console.log(`\nwithWorkspace(${String(ws.name).slice(0, 18)})`, JSON.stringify(seen));
    }
    const raw = (await sql`select count(*)::int n from jobs`.execute(db)).rows[0].n;
    console.log(`\nraw getDb() (no workspace context): jobs = ${raw}`);
    console.log('  -> if the two withWorkspace counts are EQUAL and equal to raw, isolation is off.');
  }

  process.exit(0);
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
