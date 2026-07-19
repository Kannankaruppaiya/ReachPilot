import { Injectable, Logger } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { SecretsService } from '@/modules/vault/secrets.service';
import { GoogleOAuthService } from './google-oauth.service';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Polls each connected Gmail mailbox for inbound replies, matches them to
 * leads we've emailed, and — matching Expandi behaviour — auto-pauses that
 * lead's sequence, records the reply in the unified inbox, and bumps stats.
 *
 * RLS: `workspaces` and `messages` are not tenant-scoped, so they're read
 * directly; every tenant table is accessed inside `withWorkspace`.
 */
@Injectable()
export class GmailInboxService {
  private readonly logger = new Logger(GmailInboxService.name);

  constructor(
    private readonly secrets: SecretsService,
    private readonly oauth: GoogleOAuthService,
  ) {}

  /** Sync every active Gmail mailbox across all workspaces. */
  async syncAll(): Promise<void> {
    const workspaces = await getDb().selectFrom('workspaces').select('id').execute();

    for (const ws of workspaces) {
      const accounts = await withWorkspace(ws.id, (db) =>
        db
          .selectFrom('email_accounts')
          .select(['id', 'workspace_id', 'email', 'credentials_secret_id'])
          .where('provider', '=', 'gmail')
          .where('status', '=', 'active')
          .where('credentials_secret_id', 'is not', null)
          .execute(),
      );
      for (const acct of accounts) {
        try {
          await this.syncAccount(acct as any);
        } catch (e: any) {
          this.logger.warn(`Inbox sync failed for ${acct.email}: ${e.message}`);
        }
      }
    }
  }

  private async syncAccount(acct: {
    id: string;
    workspace_id: string;
    email: string;
    credentials_secret_id: string;
  }): Promise<void> {
    const refresh = await this.secrets.decrypt(acct.credentials_secret_id, {
      workspaceId: acct.workspace_id,
    });
    const accessToken = await this.oauth.accessTokenFromRefresh(refresh);
    const auth = { Authorization: `Bearer ${accessToken}` };

    // Recent inbound messages only (exclude our own sent mail). Network only.
    const q = encodeURIComponent('newer_than:2d -in:sent -in:chats');
    const listRes = await fetch(`${GMAIL_API}/messages?q=${q}&maxResults=25`, { headers: auth });
    if (!listRes.ok) throw new Error(`list ${listRes.status}`);
    const list: any = await listRes.json();
    const ids: string[] = (list.messages || []).map((m: any) => m.id);
    if (!ids.length) return;

    for (const id of ids) {
      // messages is not RLS-scoped — dedup read is direct.
      const seen = await getDb()
        .selectFrom('messages')
        .select('id')
        .where('external_id', '=', id)
        .executeTakeFirst();
      if (seen) continue;

      const msgRes = await fetch(
        `${GMAIL_API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: auth },
      );
      if (!msgRes.ok) continue;
      const msg: any = await msgRes.json();

      const headers: any[] = msg.payload?.headers || [];
      const fromRaw = headers.find((h) => h.name === 'From')?.value || '';
      const subject = headers.find((h) => h.name === 'Subject')?.value || '';
      const fromEmail = this.extractEmail(fromRaw);
      if (!fromEmail || fromEmail.toLowerCase() === acct.email.toLowerCase()) continue;

      // Match to a lead we've contacted in this workspace.
      const lead = await withWorkspace(acct.workspace_id, (db) =>
        db
          .selectFrom('leads')
          .selectAll()
          .where('workspace_id', '=', acct.workspace_id)
          .where('email', '=', fromEmail)
          .executeTakeFirst(),
      );
      if (!lead) continue;

      await this.recordReply(acct.workspace_id, lead, id, msg.snippet || '', subject);
      this.logger.log(`Reply from ${fromEmail} → lead ${lead.id} (workspace ${acct.workspace_id})`);
    }
  }

  /** Persist the reply: thread + message, pause sequence, bump stats, notify. */
  private async recordReply(
    workspaceId: string,
    lead: any,
    externalId: string,
    body: string,
    subject: string,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const localDate = new Date().toLocaleDateString('en-US');

    await withWorkspace(workspaceId, async (db) => {
      const thread = await db
        .insertInto('threads')
        .values({
          workspace_id: workspaceId,
          lead_id: lead.id,
          channel: 'email',
          unread: true,
          last_message_at: nowIso,
        })
        .onConflict((oc) =>
          oc.columns(['lead_id', 'channel']).doUpdateSet({ unread: true, last_message_at: nowIso }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();

      await db
        .insertInto('messages')
        .values({
          thread_id: thread.id,
          direction: 'them',
          channel: 'email',
          subject,
          body: body.slice(0, 4000),
          external_id: externalId,
        })
        .execute();

      await db
        .updateTable('leads')
        .set({ status: 'replied', last_activity: 'Replied to email' })
        .where('id', '=', lead.id)
        .execute();

      // Auto-pause the lead's sequence (Expandi behaviour).
      await db
        .updateTable('enrollments')
        .set({ status: 'replied' })
        .where('workspace_id', '=', workspaceId)
        .where('lead_id', '=', lead.id)
        .execute();

      // Bump reply rollups.
      const liAcct = await db
        .selectFrom('linkedin_accounts')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .limit(1)
        .executeTakeFirst();
      if (liAcct) {
        await db
          .insertInto('daily_stats')
          .values({
            workspace_id: workspaceId,
            linkedin_account_id: liAcct.id,
            day: localDate as any,
            invites_sent: 0,
            emails_sent: 0,
            accepted: 0,
            replies: 1,
          })
          .onConflict((oc) =>
            oc.columns(['workspace_id', 'linkedin_account_id', 'day']).doUpdateSet({
              replies: (eb: any) => eb('daily_stats.replies', '+', 1),
            }),
          )
          .execute();
      }

      await db
        .insertInto('activity')
        .values({ workspace_id: workspaceId, text: `${lead.full_name || lead.email} replied by email`, tone: 'success' })
        .execute();
      await db
        .insertInto('notifications')
        .values({ workspace_id: workspaceId, kind: 'reply_received', text: `New email reply from ${lead.full_name || lead.email}` })
        .execute();
    });
  }

  private extractEmail(from: string): string | null {
    const m = from.match(/<([^>]+)>/) || from.match(/([^\s<>]+@[^\s<>]+)/);
    return m ? m[1].toLowerCase().trim() : null;
  }
}
