import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { EMAIL_DRIVER, LINKEDIN_DRIVER } from '@/modules/drivers/driver.tokens';
import { EmailDriver } from '@/modules/drivers/email-driver.interface';
import { LinkedInDriver, LinkedInActionResult, failureText } from '@/modules/drivers/linkedin-driver.interface';
import { LinkedInSessionService } from '@/modules/drivers/linkedin-session.service';

/** Account statuses that may act on LinkedIn (mirrors the scheduler's health gate). */
const SENDABLE_ACCOUNT = ['active', 'warming_up'];

@Injectable()
export class InboxService {
  constructor(
    @Inject(EMAIL_DRIVER) private readonly emailDriver: EmailDriver,
    @Inject(LINKEDIN_DRIVER) private readonly linkedinDriver: LinkedInDriver,
    private readonly sessions: LinkedInSessionService,
  ) {}

  /** All threads (LinkedIn + email) with their messages and lead context. */
  async listThreads(workspaceId: string): Promise<any[]> {
    return withWorkspace(workspaceId, async (db) => {
      const threads = await db
        .selectFrom('threads')
        .innerJoin('leads', 'leads.id', 'threads.lead_id')
        .select([
          'threads.id as id',
          'threads.lead_id as lead_id',
          'threads.channel as channel',
          'threads.unread as unread',
          'threads.last_message_at as last_message_at',
          'leads.full_name as full_name',
          'leads.first_name as first_name',
          'leads.title as title',
          'leads.company as company',
          'leads.email as email',
          'leads.location as location',
          'leads.status as status',
          'leads.tags as tags',
          'leads.linkedin_url as linkedin_url',
        ])
        .where('threads.workspace_id', '=', workspaceId)
        .orderBy('threads.last_message_at', 'desc')
        .execute();

      if (!threads.length) return [];

      const threadIds = threads.map((t) => t.id);
      const leadIds = [...new Set(threads.map((t) => t.lead_id))];

      // All messages for these threads in one query (messages isn't RLS-scoped).
      const allMsgs = await db
        .selectFrom('messages')
        .selectAll()
        .where('thread_id', 'in', threadIds)
        .orderBy('sent_at', 'asc')
        .execute();
      const msgsByThread = new Map<string, any[]>();
      for (const m of allMsgs) {
        const arr = msgsByThread.get(m.thread_id) || [];
        arr.push(m);
        msgsByThread.set(m.thread_id, arr);
      }

      // Campaign name per lead (best-effort — latest enrollment wins).
      const enr = await db
        .selectFrom('enrollments')
        .innerJoin('campaigns', 'campaigns.id', 'enrollments.campaign_id')
        .select(['enrollments.lead_id as lead_id', 'campaigns.name as campaign'])
        .where('enrollments.workspace_id', '=', workspaceId)
        .where('enrollments.lead_id', 'in', leadIds)
        .execute();
      const campaignByLead = new Map(enr.map((e) => [e.lead_id, e.campaign]));

      return threads.map((t) => {
        const msgs = msgsByThread.get(t.id) || [];
        const last = msgs[msgs.length - 1];
        return {
          id: t.id,
          leadId: t.lead_id,
          channel: t.channel,
          unread: t.unread,
          preview: last ? String(last.body).substring(0, 60) : '',
          time: last ? this.formatTimeDiff(new Date(last.sent_at)) : 'Just now',
          leadName: t.full_name,
          leadFirstName: t.first_name,
          leadTitle: t.title,
          leadCompany: t.company,
          leadEmail: t.email,
          leadLocation: t.location,
          leadStatus: t.status,
          leadTags: t.tags || [],
          campaign: campaignByLead.get(t.lead_id) || null,
          messages: msgs.map((m) => ({
            from: m.direction,
            channel: m.channel,
            subject: m.subject || undefined,
            text: m.body,
            time: this.formatTime(new Date(m.sent_at)),
          })),
        };
      });
    });
  }

  /**
   * Reply in a thread. For email threads this sends a REAL email via the
   * connected mailbox; for LinkedIn it goes through the LinkedIn driver.
   * The outgoing message is recorded only after a successful send.
   */
  async sendMessage(workspaceId: string, threadId: string, text: string): Promise<any> {
    const body = (text || '').trim();
    if (!body) throw new BadRequestException("Message can't be empty.");

    // Load the thread + lead under RLS.
    const thread = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('threads')
        .innerJoin('leads', 'leads.id', 'threads.lead_id')
        .select([
          'threads.id as id',
          'threads.lead_id as lead_id',
          'threads.channel as channel',
          'leads.email as email',
          'leads.full_name as full_name',
          'leads.linkedin_url as linkedin_url',
        ])
        .where('threads.workspace_id', '=', workspaceId)
        .where('threads.id', '=', threadId)
        .executeTakeFirst(),
    );
    if (!thread) throw new NotFoundException('Thread not found.');

    // Reply subject from the most recent inbound message (email only).
    const lastInbound = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('messages')
        .select(['subject'])
        .where('thread_id', '=', threadId)
        .where('direction', '=', 'them')
        .orderBy('sent_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    const baseSubject = lastInbound?.subject || `Message from ${thread.full_name || 'us'}`;
    const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;

    // Perform the real send.
    let externalId: string | undefined;
    if (thread.channel === 'email') {
      if (!thread.email) throw new BadRequestException('This lead has no email address.');
      const res = await this.emailDriver.sendEmail(thread.email, subject, body, { workspaceId });
      if (res.status !== 'sent') {
        throw new BadRequestException(`Email send failed: ${res.error || 'unknown error'}`);
      }
      externalId = res.externalId;
    } else {
      externalId = await this.sendLinkedInReply(workspaceId, thread.lead_id, thread.linkedin_url, body);
    }

    // Record the outgoing message + mark the thread read.
    const now = new Date().toISOString();
    await withWorkspace(workspaceId, async (db) => {
      await db
        .insertInto('messages')
        .values({
          thread_id: threadId,
          direction: 'me',
          channel: thread.channel,
          subject: thread.channel === 'email' ? subject : null,
          body,
          external_id: externalId || null,
          sent_at: now,
        })
        .execute();
      await db
        .updateTable('threads')
        .set({ unread: false, last_message_at: now })
        .where('id', '=', threadId)
        .execute();
    });

    // Return the refreshed thread's messages for immediate UI update.
    const messages = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('messages')
        .selectAll()
        .where('thread_id', '=', threadId)
        .orderBy('sent_at', 'asc')
        .execute(),
    );
    return {
      id: threadId,
      leadId: thread.lead_id,
      channel: thread.channel,
      unread: false,
      messages: messages.map((m) => ({
        from: m.direction,
        channel: m.channel,
        subject: m.subject || undefined,
        text: m.body,
        time: this.formatTime(new Date(m.sent_at)),
      })),
    };
  }

  /**
   * Send a LinkedIn reply AS one of the workspace's accounts, or throw.
   *
   * 🔴 This used to call the driver with no account at all and ignore the
   * result, then record the message as sent. In production (remote driver) a
   * call without an account returns `failed: no_account_id` at once — so every
   * LinkedIn reply from the inbox showed as sent while nothing reached the
   * prospect. Now the reply goes out through a real account session, and only a
   * confirmed `sent` is recorded; anything else is reported to the user.
   */
  private async sendLinkedInReply(
    workspaceId: string,
    leadId: string,
    linkedinUrl: string | null,
    body: string,
  ): Promise<string | undefined> {
    if (!linkedinUrl) throw new BadRequestException('This lead has no LinkedIn profile URL.');

    const accountId = await this.replyAccountFor(workspaceId, leadId);
    if (!accountId) {
      throw new BadRequestException('Connect a LinkedIn account to reply on LinkedIn.');
    }
    const ctx = await this.sessions.buildActionContext(accountId, workspaceId);
    if (!ctx) {
      throw new BadRequestException(
        'Your LinkedIn account is paused or needs reconnecting, so the reply was not sent.',
      );
    }

    let res: LinkedInActionResult;
    try {
      res = await this.linkedinDriver.sendMessage(linkedinUrl, body, ctx);
    } catch (err: any) {
      res = { status: 'failed', error: String(err?.message || err) };
    }
    if (res.status === 'sent') return res.externalId;

    if (res.error === 'agent_unavailable') {
      throw new BadRequestException('The ReachPilot desktop app is offline. Open it and try again. Nothing was sent.');
    }
    if (res.error === 'agent_result_pending') {
      // The agent took the job but never confirmed it — it may have gone out.
      throw new BadRequestException(
        'The desktop app did not confirm this message. Check LinkedIn before sending it again, so it is not sent twice.',
      );
    }
    throw new BadRequestException(`LinkedIn reply not sent: ${failureText(res.error || res.status)}`);
  }

  /**
   * The account to reply from: the one that last reached this lead (the
   * conversation lives in that account's inbox), else the workspace's most
   * recently connected account that may send.
   */
  private async replyAccountFor(workspaceId: string, leadId: string): Promise<string | null> {
    return withWorkspace(workspaceId, async (db) => {
      const lastUsed = await db
        .selectFrom('jobs')
        .innerJoin('linkedin_accounts', 'linkedin_accounts.id', 'jobs.linkedin_account_id')
        .select('jobs.linkedin_account_id as id')
        .where('jobs.workspace_id', '=', workspaceId)
        .where('jobs.lead_id', '=', leadId)
        .where('jobs.kind', '=', 'linkedin')
        .where('jobs.status', '=', 'sent')
        .where('linkedin_accounts.status', 'in', SENDABLE_ACCOUNT)
        .orderBy('jobs.sent_at', 'desc')
        .executeTakeFirst();
      if (lastUsed?.id) return lastUsed.id as string;

      const fallback = await db
        .selectFrom('linkedin_accounts')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('status', 'in', SENDABLE_ACCOUNT)
        .orderBy('connected_at', 'desc')
        .executeTakeFirst();
      return (fallback?.id as string) ?? null;
    });
  }

  private formatTime(d: Date): string {
    const hours = d.getHours();
    const minutes = d.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours % 12 || 12;
    return `Today ${h12}:${minutes} ${ampm}`;
  }

  private formatTimeDiff(d: Date): string {
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d`;
  }
}
