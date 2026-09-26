import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '@/db';

/**
 * Mailboxes that can send (active Gmail with OAuth credentials), newest first.
 * Always pick a sender through this; an unordered `limit(1)` can pick a dead row.
 */
export function sendableMailboxes(db: Kysely<DatabaseSchema>, workspaceId: string) {
  return db
    .selectFrom('email_accounts')
    .where('workspace_id', '=', workspaceId)
    .where('provider', '=', 'gmail')
    .where('status', '=', 'active')
    .where('credentials_secret_id', 'is not', null)
    .orderBy('connected_at', 'desc');
}
