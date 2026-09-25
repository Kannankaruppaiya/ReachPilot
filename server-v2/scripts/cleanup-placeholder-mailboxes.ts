/**
 * Remove the placeholder Gmail rows the old onboarding "Connect Gmail" step left.
 *
 * That button never ran OAuth. It inserted an email_accounts row with a
 * hardcoded address, status 'active' and NO credentials into the workspace —
 * a row nothing can send from. Senders were then picked with an unordered
 * limit(1), so whenever the placeholder came first, Auto Mail / campaign emails
 * failed NO_MAILBOX, and the Integrations page showed Gmail as connected.
 *
 * Signature: provider 'gmail', status 'active', credentials_secret_id IS NULL.
 * No real flow produces it — OAuth always stores credentials, and a disconnect
 * sets status 'disconnected'. Deleting the row nulls email_account_id on jobs
 * that named it (FK ON DELETE SET NULL); the Gmail driver then sends from the
 * workspace's real mailbox.
 *
 * Read-only unless --apply. Runs per workspace under withWorkspace, so it works
 * for a role subject to RLS as well as for the bypassing one.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/cleanup-placeholder-mailboxes.ts [--apply]
 */
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';

const APPLY = process.argv.includes('--apply');

(async () => {
  const workspaces = await getDb().selectFrom('workspaces').select(['id', 'name']).execute();
  let found = 0;

  for (const ws of workspaces) {
    const rows = await withWorkspace(ws.id, (db) =>
      db
        .selectFrom('email_accounts')
        .select(['id', 'email', 'created_at'])
        .where('workspace_id', '=', ws.id)
        .where('provider', '=', 'gmail')
        .where('status', '=', 'active')
        .where('credentials_secret_id', 'is', null)
        .execute(),
    );
    if (!rows.length) continue;
    found += rows.length;
    for (const r of rows) console.log(`  ${ws.name || ws.id}  →  ${r.email}  (row ${r.id})`);

    if (APPLY) {
      await withWorkspace(ws.id, (db) =>
        db
          .deleteFrom('email_accounts')
          .where('workspace_id', '=', ws.id)
          .where('id', 'in', rows.map((r) => r.id))
          .where('credentials_secret_id', 'is', null)
          .execute(),
      );
    }
  }

  if (!found) console.log('No placeholder mailboxes found.');
  else if (APPLY) console.log(`\nDeleted ${found} placeholder mailbox row(s).`);
  else console.log(`\nDRY RUN — nothing written. Re-run with --apply to delete these ${found}.`);
  await getDb().destroy();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
