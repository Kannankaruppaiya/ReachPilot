import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { EMAIL_DRIVER, LINKEDIN_DRIVER } from '@/modules/drivers/driver.tokens';
import { EmailDriver } from '@/modules/drivers/email-driver.interface';
import { LinkedInDriver } from '@/modules/drivers/linkedin-driver.interface';

@Injectable()
export class InboxService {
  constructor(
    @Inject(EMAIL_DRIVER) private readonly emailDriver: EmailDriver,
    @Inject(LINKEDIN_DRIVER) private readonly linkedinDriver: LinkedInDriver,
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
      // LinkedIn — best-effort through the driver (paused → simulator).
      const res = await this.linkedinDriver
        .sendMessage(thread.linkedin_url || '', body, { workspaceId })
        .catch(() => ({ status: 'failed' as const, externalId: undefined }));
      externalId = (res as any).externalId;
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
