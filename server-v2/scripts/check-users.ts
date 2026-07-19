/** Reports app auth accounts + related tenant data (read-only). */
import { getDb } from '../src/db';

async function main() {
  const db = getDb();
  const users = await db.selectFrom('users').select(['id', 'email', 'created_at']).execute().catch(() => []);
  const sessions = await db.selectFrom('user_sessions').select(['id']).execute().catch(() => []);
  const workspaces = await db.selectFrom('workspaces').select(['id', 'name']).execute().catch(() => []);
  const memberships = await db.selectFrom('memberships').select(['user_id', 'workspace_id']).execute?.().catch(() => []) ?? [];

  console.log(`\n=== App auth state ===`);
  console.log(`users: ${users.length}`);
  for (const u of users) console.log(`  - ${u.email}  (id ${String(u.id).slice(0, 8)}…, created ${u.created_at})`);
  console.log(`user_sessions (active refresh tokens): ${sessions.length}`);
  console.log(`workspaces: ${workspaces.length}`);
  for (const w of workspaces) console.log(`  - ${w.name}  (id ${String(w.id).slice(0, 8)}…)`);
  console.log(`memberships: ${(memberships as any[]).length}`);
  console.log('');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
