import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '@/db';

/**
 * The workspace's mailboxes that can actually send, most recently connected first.
 *
 * "Can send" = an active Gmail row that holds OAuth credentials. The onboarding
 * "Connect Gmail" button used to insert a placeholder row — active, no
 * credentials, and a hardcoded address — into every workspace, and senders were
 * picked with an unordered `limit(1)` over ALL rows. Whenever the placeholder
 * came first, every Auto Mail / campaign email failed with NO_MAILBOX even though
 * the user had connected a real inbox. Always pick through here.
 *
 * Returns a query already scoped and ordered; callers choose the columns.
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
