import { Inject, Injectable, Logger } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { LINKEDIN_DRIVER } from './driver.tokens';
import { LinkedInDriver, LinkedInSyncResult } from './linkedin-driver.interface';
import { LinkedInSessionService } from './linkedin-session.service';

const nowIso = () => new Date().toISOString();
const localDate = () => new Date().toLocaleDateString('en-US');

/** Extract the `/in/<slug>` handle from a LinkedIn profile URL (for lead matching). */
const profileSlug = (url?: string | null): string =>
  (String(url || '').match(/\/in\/([^/?#]+)/i)?.[1] || '').toLowerCase();

/** LinkedIn account statuses we actively sync (mirrors the send gate). */
const SENDABLE_ACCT = ['warming_up', 'active', 'connecting'];

/**
 * The LinkedIn counterpart to the Gmail inbox sync — this is B4.
 *
 * For every sendable account it asks the driver (read-only) which invites were
 * accepted and which replies arrived, then applies those observations to lead
 * state: invited → accepted, accepted → replied (+ inbox thread, auto-pause of
 * the sequence). It also withdraws stale pending invites.
 *
 * The `apply()` step is deliberately separate from the polling loop so it can be
 * unit-verified with a hand-built sync result, independent of any browser.
 */
@Injectable()
export class LinkedInSyncService {
  private readonly logger = new Logger(LinkedInSyncService.name);

  constructor(
    @Inject(LINKEDIN_DRIVER) private readonly driver: LinkedInDriver,
    private readonly sessions: LinkedInSessionService,
  ) {}

  /** Poll every sendable account across all workspaces and apply what we find. */
  async syncAll(): Promise<{ accounts: number; accepted: number; replies: number }> {
    const totals = { accounts: 0, accepted: 0, replies: 0 };
    let workspaces: { id: string }[] = [];
    try {
      workspaces = await getDb().selectFrom('workspaces').select('id').execute();
    } catch (err: any) {
      this.logger.warn({ err: err.message }, 'workspace scan failed');
      return totals;
    }

    for (const ws of workspaces) {
      let accounts: { id: string }[] = [];
      try {
        accounts = await withWorkspace(ws.id, (db) =>
          db.selectFrom('linkedin_accounts').select('id').where('status', 'in', SENDABLE_ACCT as any).execute(),
        );
      } catch {
        continue;
      }

      for (const acct of accounts) {
        const ctx = await this.sessions.buildActionContext(acct.id, ws.id).catch(() => null);
        if (!ctx) continue;
        totals.accounts++;

        let result: LinkedInSyncResult;
        try {
          result = await this.driver.syncAccount(ctx);
        } catch (err: any) {
          this.logger.warn({ accountId: acct.id, err: err.message }, 'syncAccount failed');
          continue;
        }

        if (result.checkpoint) {
          await this.pauseForCheckpoint(ws.id, acct.id).catch(() => undefined);
          continue;
        }

        const applied = await this.apply(ws.id, acct.id, result);
        totals.accepted += applied.accepted;
        totals.replies += applied.replies;

        // Withdrawing is destructive — it retracts real invitations, including
        // ones a human sent by hand — so it only runs when explicitly enabled.
        const env = getEnv();
        if (env.LINKEDIN_WITHDRAW_ENABLED) {
          try {
            const w = await this.driver.withdrawStaleInvites(env.WITHDRAW_AFTER_DAYS, ctx);
            if (w.withdrawn > 0) this.logger.log(`Withdrew ${w.withdrawn} stale invites for ${acct.id}`);
          } catch {
            /* best-effort housekeeping */
          }
        }
      }
    }

    if (totals.accepted || totals.replies) {
      this.logger.log(`LinkedIn sync: accepted=${totals.accepted} replies=${totals.replies} across ${totals.accounts} accounts`);
    }
    return totals;
  }

  /**
   * Apply a sync result to the DB for one account. Idempotent: an accepted lead
   * won't be re-accepted (matched only while `status='invited'`), and a reply
   * with a known `externalId` is skipped if already ingested.
   */
  async apply(
    workspaceId: string,
    accountId: string,
    result: LinkedInSyncResult,
  ): Promise<{ accepted: number; replies: number }> {
    let accepted = 0;
    let replies = 0;

    for (const a of result.accepted || []) {
      const slug = profileSlug(a.profileUrl);
      if (!slug) continue;
      try {
        const did = await withWorkspace(workspaceId, async (db) => {
          const lead = await db
            .selectFrom('leads')
            .select(['id', 'full_name'])
            .where('linkedin_url', 'ilike', `%/in/${slug}%`)
            .where('status', '=', 'invited')
            .executeTakeFirst();
          if (!lead) return false;
          await db.updateTable('leads').set({ status: 'accepted', last_activity: 'Invite accepted' }).where('id', '=', lead.id).execute();
          await db.insertInto('activity').values({ workspace_id: workspaceId, text: `Invite accepted — ${lead.full_name}`, tone: 'accent' }).execute();
          await this.bumpStat(db, workspaceId, accountId, 'accepted');
          return true;
        });
        if (did) accepted++;
      } catch (err: any) {
        this.logger.warn({ accountId, err: err.message }, 'apply-accepted failed');
      }
    }

    for (const r of result.replies || []) {
      const slug = profileSlug(r.profileUrl);
      try {
        const did = await withWorkspace(workspaceId, async (db) => {
          let lead = slug
            ? await db.selectFrom('leads').select(['id', 'full_name']).where('linkedin_url', 'ilike', `%/in/${slug}%`).executeTakeFirst()
            : undefined;
          if (!lead && r.fromName) {
            lead = await db.selectFrom('leads').select(['id', 'full_name']).where('full_name', 'ilike', r.fromName).executeTakeFirst();
          }
          if (!lead) return false;

          if (r.externalId) {
            const seen = await db.selectFrom('messages').select('id').where('external_id', '=', r.externalId).executeTakeFirst();
            if (seen) return false;
          }

          await db.updateTable('leads').set({ status: 'replied', last_activity: 'Replied on LinkedIn' }).where('id', '=', lead.id).execute();
          const thread = await db
            .insertInto('threads')
            .values({ workspace_id: workspaceId, lead_id: lead.id, channel: 'linkedin', unread: true, last_message_at: nowIso() })
            .onConflict((oc: any) => oc.columns(['lead_id', 'channel']).doUpdateSet({ unread: true, last_message_at: nowIso() }))
            .returning('id')
            .executeTakeFirstOrThrow();
          await db.insertInto('messages').values({ thread_id: thread.id, direction: 'them', channel: 'linkedin', body: r.text, external_id: r.externalId || 'li_reply_' + Date.now().toString(36) }).execute();
          await db.insertInto('activity').values({ workspace_id: workspaceId, text: `${lead.full_name} replied on LinkedIn`, tone: 'success' }).execute();
          await db.updateTable('enrollments').set({ status: 'replied' }).where('workspace_id', '=', workspaceId).where('lead_id', '=', lead.id).execute();
          await this.bumpStat(db, workspaceId, accountId, 'replies');
          return true;
        });
        if (did) replies++;
      } catch (err: any) {
        this.logger.warn({ accountId, err: err.message }, 'apply-reply failed');
      }
    }

    return { accepted, replies };
  }

  private async pauseForCheckpoint(workspaceId: string, accountId: string): Promise<void> {
    await withWorkspace(workspaceId, async (db) => {
      await db.updateTable('linkedin_accounts').set({ status: 'checkpoint' }).where('id', '=', accountId).execute();
      await db.insertInto('notifications').values({ workspace_id: workspaceId, kind: 'account_checkpoint', text: 'LinkedIn security checkpoint detected during sync — automation paused. Please verify your account.' }).execute();
    });
  }

  private async bumpStat(db: any, workspaceId: string, accountId: string, field: 'accepted' | 'replies'): Promise<void> {
    if (!accountId) return;
    await db
      .insertInto('daily_stats')
      .values({
        workspace_id: workspaceId,
        linkedin_account_id: accountId,
        day: localDate() as any,
        invites_sent: 0,
        emails_sent: 0,
        accepted: field === 'accepted' ? 1 : 0,
        replies: field === 'replies' ? 1 : 0,
      })
      .onConflict((oc: any) =>
        oc.columns(['workspace_id', 'linkedin_account_id', 'day']).doUpdateSet({
          [field]: (eb: any) => eb(`daily_stats.${field}`, '+', 1),
        }),
      )
      .execute();
  }
}
