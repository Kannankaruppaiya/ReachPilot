/**
 * Delete the placeholder Gmail rows the old onboarding step created (gmail,
 * active, no credentials); no real flow produces that shape. Jobs that named one
 * fall back to the workspace's real mailbox (FK ON DELETE SET NULL). Runs per
 * workspace under withWorkspace. Read-only unless --apply.
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
