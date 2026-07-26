/**
 * FULL DATA RESET — wipes all users, sessions, workspaces and tenant data so you
 * can sign up from scratch. Preserves system-seed tables only: plans, proxies,
 * migrations_log.
 *
 * RLS-safe: tenant tables are FORCE-RLS, so they're deleted per-workspace under
 * withWorkspace; non-tenant tables are deleted globally. FK ordering is handled
 * by repeating passes until nothing is left (each pass frees the next layer).
 *
 * Guarded: refuses to run without --yes.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/reset-db.ts --yes
 */
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';

const _KEEP = new Set(['plans', 'proxies', 'migrations_log']);

// Tenant tables (FORCE RLS) — deleted per workspace.
const RLS_TABLES = [
  'webhook_deliveries', 'jobs', 'enrollments', 'ab_variants', 'ab_tests', 'threads',
  'invoices', 'subscriptions', 'daily_stats', 'hourly_stats', 'campaign_stats', 'template_stats',
  'notifications', 'activity', 'audit_log', 'api_keys', 'integrations', 'webhook_endpoints',
  'secrets', 'encryption_keys', 'blacklist', 'templates', 'leads', 'campaigns',
  'linkedin_accounts', 'email_accounts', 'invitations', 'memberships',
];

// Non-RLS tenant-linked children, deleted globally BEFORE their RLS parents.
const GLOBAL_CHILD = ['messages', 'campaign_steps'];

// Identity/global tables, deleted last (children before users, then workspaces).
const GLOBAL_LAST = [
  'user_sessions', 'oauth_identities', 'password_reset_tokens', 'email_verification_tokens',
  'mfa_backup_codes', 'user_mfa', 'users', 'workspaces',
];

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to wipe without --yes. Re-run:  ... reset-db.ts --yes');
    process.exit(1);
  }
  const db = getDb();

  const before = {
    users: (await db.selectFrom('users').select('id').execute()).length,
    workspaces: (await db.selectFrom('workspaces').select('id').execute()).length,
    linkedin_accounts: (await db.selectFrom('linkedin_accounts').select('id').execute()).length,
  };
  console.log(`\nBefore: users=${before.users} workspaces=${before.workspaces} linkedin_accounts=${before.linkedin_accounts}`);

  const del = async (fn: () => Promise<any>) => {
    try {
      await fn();
      return true;
    } catch {
      return false; // FK not yet satisfied — a later pass will get it
    }
  };

  // Multi-pass clear of tenant + global-child data.
  for (let pass = 1; pass <= 6; pass++) {
    for (const t of GLOBAL_CHILD) await del(() => db.deleteFrom(t as any).execute());
    const workspaces = await db.selectFrom('workspaces').select('id').execute();
    for (const ws of workspaces) {
      for (const t of RLS_TABLES) {
        await del(() => withWorkspace(ws.id, (trx) => trx.deleteFrom(t as any).execute()));
      }
      // secrets/encryption_keys may be global rather than RLS — try globally too.
      await del(() => db.deleteFrom('secrets' as any).execute());
      await del(() => db.deleteFrom('encryption_keys' as any).execute());
    }
    process.stdout.write(`  pass ${pass} done\n`);
  }

  // Now the identity/global layer, children first.
  for (const t of GLOBAL_LAST) {
    const ok = await del(() => db.deleteFrom(t as any).execute());
    console.log(`  cleared ${t}: ${ok ? 'ok' : 'FK-blocked (rerun?)'}`);
  }

  const after = {
    users: (await db.selectFrom('users').select('id').execute()).length,
    workspaces: (await db.selectFrom('workspaces').select('id').execute()).length,
    linkedin_accounts: (await db.selectFrom('linkedin_accounts').select('id').execute()).length,
    plans: (await db.selectFrom('plans').select('id').execute().catch(() => [])).length,
    proxies: (await db.selectFrom('proxies').select('id').execute().catch(() => [])).length,
  };
  console.log(`\nAfter:  users=${after.users} workspaces=${after.workspaces} linkedin_accounts=${after.linkedin_accounts}`);
  console.log(`Kept:   plans=${after.plans} proxies=${after.proxies}`);

  const clean = after.users === 0 && after.workspaces === 0 && after.linkedin_accounts === 0;
  console.log(`\n${clean ? '✅ Database cleared — ready for a fresh signup.' : '⚠️ Some rows remain — see FK-blocked notes above.'}\n`);
  process.exit(clean ? 0 : 1);
}

main().catch((err) => { console.error('reset crashed:', err); process.exit(1); });
