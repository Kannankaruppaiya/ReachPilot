/**
 * Reports LinkedIn accounts + secrets. IMPORTANT: linkedin_accounts and secrets
 * are FORCE-RLS, so they MUST be read under withWorkspace — a plain getDb() read
 * silently returns 0 rows. We enumerate workspaces (not RLS'd) and scan each.
 */
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';

async function main() {
  const db = getDb();
  const workspaces = await db.selectFrom('workspaces').select(['id', 'name']).execute();
  console.log(`\nWorkspaces: ${workspaces.length}`);

  let totalAccts = 0;
  for (const ws of workspaces) {
    const accts = await withWorkspace(ws.id, (d) =>
      d.selectFrom('linkedin_accounts').selectAll().execute(),
    ).catch((e) => { console.log('  (read error)', e.message); return [] as any[]; });
    const secrets = await withWorkspace(ws.id, (d) =>
      d.selectFrom('secrets').select(['id', 'kind']).execute(),
    ).catch(() => [] as any[]);

    console.log(`\n▸ ${ws.name}  (${ws.id.slice(0, 8)}…)`);
    console.log(`   linkedin_accounts: ${accts.length}   secrets: ${secrets.length}`);
    for (const a of accts) {
      totalAccts++;
      console.log(`   • ${a.email}  [status=${a.status}]`);
      console.log(`       password stored:  ${a.password_secret_id ? 'YES' : 'no'}`);
      console.log(`       2FA/TOTP stored:   ${a.totp_secret_id ? 'YES' : 'no'}`);
      console.log(`       session cookie:    ${a.session_secret_id ? 'YES (logged in)' : 'no (not logged in yet)'}`);
      console.log(`       connected_at=${a.connected_at || '-'}  last_sync_at=${a.last_sync_at || '-'}`);
    }
    for (const s of secrets) console.log(`   · secret: kind=${s.kind}`);
  }

  console.log(`\n=== TOTAL linkedin_accounts across all workspaces: ${totalAccts} ===\n`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
