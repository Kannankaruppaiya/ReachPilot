import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { SecretsService } from '@/modules/vault/secrets.service';
import { GoogleOAuthService } from '@/modules/integrations/google-oauth.service';
import { GmailDriver } from './gmail.driver';
import { spin } from '@/modules/engine/spintax';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

let redisClient: Redis | null = null;
function getRedis(): Redis {
  if (redisClient) return redisClient;
  redisClient = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redisClient;
}

/** Natural-looking warm-up content — spintax so no two mails share a body. */
const SUBJECTS = [
  '{Quick|Small|One quick} {question|thing|note}',
  '{Following up|Checking in} on {that idea|the plan|our chat}',
  '{Thoughts|Your take} on {this|the draft}?',
  '{Notes|Update} from {today|this week|the meeting}',
  '{Re-reading|Went through} {the doc|your notes} {again|today}',
];
const BODIES = [
  '{Hey|Hi},\n\n{Was thinking about|Kept coming back to} {what we discussed|that idea from last time}. {I think it holds up|Still makes sense to me} — {let me know your take|curious what you think}.\n\n{Cheers|Thanks}',
  '{Hi|Hey},\n\n{Quick one|Short note} — {did you get a chance to look at|any thoughts on} {the draft|that doc}? {No rush|Whenever you get a minute}.\n\n{Thanks|Best}',
  '{Hey|Hello},\n\n{Jotting this down before I forget|Wanted to note this down}: {we should revisit|worth revisiting} {the plan|the outline} {next week|soon}. {More soon|Will follow up}.\n\n{Cheers|Talk soon}',
  '{Hi|Hey},\n\n{Read something today that reminded me of|Came across a thing related to} {our conversation|what you mentioned}. {Will share when we talk|Remind me to bring it up}.\n\n{Best|Cheers}',
];
const REPLIES = [
  '{Sounds good|Makes sense} — {agreed|same here}. {Talk soon|More later}.',
  '{Thanks for this|Got it}. {Will take a look|On it} {today|this week}.',
  '{Yes|Yep}, {let\'s do that|works for me}. {Ping me anytime|Whenever suits}.',
  '{Good point|Fair enough} — {let\'s pick it up next week|adding it to the list}.',
];

interface PoolAccount {
  id: string;
  workspace_id: string;
  email: string;
  credentials_secret_id: string;
  connected_at: string | Date | null;
}

/**
 * Private email warm-up loop (the mechanic behind Instantly/Mailwarm-style
 * warm-up, scoped to the workspace's OWN connected mailboxes):
 *
 *  - SEND: each Gmail mailbox mails a random peer mailbox a short, natural,
 *    spintax-varied note, on a ramped daily budget with randomized gaps.
 *  - RECEIVE: each mailbox finds warm-up mail addressed to it (matched by a
 *    per-workspace token in the body), and produces the engagement signals
 *    Gmail's filter weighs: rescue from spam → inbox, mark read, star some,
 *    reply to some (threaded).
 *
 * Everything is Gmail API only — no browser. Needs ≥2 active Gmail mailboxes
 * in a workspace and the gmail.modify scope (re-connect older mailboxes).
 */
@Injectable()
export class EmailWarmupService {
  private readonly logger = new Logger(EmailWarmupService.name);

  constructor(
    private readonly secrets: SecretsService,
    private readonly oauth: GoogleOAuthService,
    private readonly gmail: GmailDriver,
  ) {}

  /** One scheduler tick: run every workspace's pool. Never throws. */
  async tick(): Promise<void> {
    const workspaces = await getDb().selectFrom('workspaces').select('id').execute();
    for (const ws of workspaces) {
      try {
        const pool = (await withWorkspace(ws.id, (db) =>
          db
            .selectFrom('email_accounts')
            .select(['id', 'workspace_id', 'email', 'credentials_secret_id', 'connected_at'])
            .where('provider', '=', 'gmail')
            .where('status', '=', 'active')
            .where('credentials_secret_id', 'is not', null)
            .execute(),
        )) as PoolAccount[];
        if (pool.length >= 2) await this.runPool(ws.id, pool);
      } catch (e: any) {
        this.logger.warn(`Warm-up tick failed for workspace ${ws.id}: ${e.message}`);
      }
    }
  }

  /** Per-workspace marker embedded in warm-up bodies; how mail is recognized. */
  private token(workspaceId: string): string {
    return createHash('sha256').update(`rp-warmup:${workspaceId}`).digest('hex').slice(0, 6);
  }

  private async runPool(workspaceId: string, pool: PoolAccount[]): Promise<void> {
    const token = this.token(workspaceId);

    // Receive side first: engagement on already-delivered mail matters more
    // than sending new mail, and it must run even outside sending hours.
    for (const acct of pool) {
      try {
        await this.engageInbox(acct, pool, token);
      } catch (e: any) {
        this.logger.warn(`Warm-up engage failed for ${acct.email}: ${e.message}`);
      }
    }

    // Send side: humans don't mail at 3am.
    const hour = new Date().getHours();
    if (hour < 8 || hour >= 21) return;

    for (const acct of pool) {
      try {
        await this.maybeSend(workspaceId, acct, pool, token);
      } catch (e: any) {
        this.logger.warn(`Warm-up send failed for ${acct.email}: ${e.message}`);
      }
    }
  }

  /* ---------- send side ---------- */

  /** Ramp: 2/day at connect, +1 every 2 days, capped by env. */
  private dailyBudget(connectedAt: string | Date | null): number {
    const age = connectedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(connectedAt).getTime()) / 86400000))
      : 0;
    return Math.min(2 + Math.floor(age / 2), getEnv().EMAIL_WARMUP_MAX_PER_DAY);
  }

  private async maybeSend(
    workspaceId: string,
    acct: PoolAccount,
    pool: PoolAccount[],
    token: string,
  ): Promise<void> {
    const redis = getRedis();
    const today = new Date().toISOString().slice(0, 10);
    const countKey = `warmup:email:sent:${acct.id}:${today}`;

    const sent = Number((await redis.get(countKey)) || 0);
    if (sent >= this.dailyBudget(acct.connected_at)) return;

    // Randomized 45–90 min gap between one mailbox's warm-up sends.
    const last = Number((await redis.get(`warmup:email:last:${acct.id}`)) || 0);
    const gapMs = (45 + Math.random() * 45) * 60_000;
    if (Date.now() - last < gapMs) return;

    // Coin flip per tick so sends don't tick like a metronome.
    if (Math.random() < 0.5) return;

    const peers = pool.filter((p) => p.id !== acct.id);
    const peer = peers[Math.floor(Math.random() * peers.length)];

    const subject = spin(SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)]);
    const body = `${spin(BODIES[Math.floor(Math.random() * BODIES.length)])}\n\n[${token}]`;

    const res = await this.gmail.sendEmail(peer.email, subject, body, {
      workspaceId,
      emailAccountId: acct.id,
    });
    if (res.status !== 'sent') {
      this.logger.warn(`Warm-up send ${acct.email} → ${peer.email} failed: ${res.error}`);
      return;
    }

    await redis.multi().incr(countKey).expire(countKey, 2 * 86400).exec();
    await redis.set(`warmup:email:last:${acct.id}`, String(Date.now()));
    this.logger.log(`Warm-up mail sent: ${acct.email} → ${peer.email}`);
  }

  /* ---------- receive side ---------- */

  private async engageInbox(acct: PoolAccount, pool: PoolAccount[], token: string): Promise<void> {
    const redis = getRedis();
    const refresh = await this.secrets.decrypt(acct.credentials_secret_id, {
      workspaceId: acct.workspace_id,
    });
    const accessToken = await this.oauth.accessTokenFromRefresh(refresh);
    const auth = { Authorization: `Bearer ${accessToken}` };
    const poolEmails = new Set(pool.map((p) => p.email.toLowerCase()));

    // in:anywhere includes SPAM — the whole point is finding mail that fell in.
    const q = encodeURIComponent(`in:anywhere "${token}" newer_than:3d`);
    const listRes = await fetch(`${GMAIL_API}/messages?q=${q}&maxResults=20`, { headers: auth });
    if (!listRes.ok) throw new Error(`warm-up list ${listRes.status}`);
    const list: any = await listRes.json();

    let rescued = 0;
    for (const m of list.messages || []) {
      // Each message is engaged once per mailbox, ever.
      const fresh = await redis.sadd(`warmup:email:seen:${acct.id}`, m.id);
      await redis.expire(`warmup:email:seen:${acct.id}`, 7 * 86400);
      if (!fresh) continue;

      const msgRes = await fetch(
        `${GMAIL_API}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`,
        { headers: auth },
      );
      if (!msgRes.ok) continue;
      const msg: any = await msgRes.json();

      const labels: string[] = msg.labelIds || [];
      const headers: any[] = msg.payload?.headers || [];
      const header = (n: string) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || '';
      const fromEmail = (header('From').match(/[\w.+-]+@[\w.-]+/) || [''])[0].toLowerCase();

      // Only inbound warm-up mail from a pool peer — never our own sent copy.
      if (labels.includes('SENT')) continue;
      if (!poolEmails.has(fromEmail) || fromEmail === acct.email.toLowerCase()) continue;

      // The engagement signals, strongest first.
      const remove: string[] = [];
      const add: string[] = [];
      if (labels.includes('SPAM')) {
        remove.push('SPAM');
        add.push('INBOX');
        rescued++;
      }
      if (labels.includes('UNREAD')) remove.push('UNREAD');
      if (Math.random() < 0.3) add.push('STARRED');

      if (remove.length || add.length) {
        const modRes = await fetch(`${GMAIL_API}/messages/${m.id}/modify`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ removeLabelIds: remove, addLabelIds: add }),
        });
        if (modRes.status === 403) {
          // Old token without gmail.modify — surface once a day, keep going.
          const warned = await redis.set(`warmup:email:scopewarn:${acct.id}`, '1', 'EX', 86400, 'NX');
          if (warned) {
            this.logger.warn(
              `${acct.email}: gmail.modify not granted — re-connect this mailbox in Integrations to enable spam-rescue/mark-read.`,
            );
          }
        }
      }

      // Reply to some threads (one reply per thread, ever).
      if (Math.random() < 0.35) {
        const freshThread = await redis.sadd('warmup:email:replied', msg.threadId);
        if (freshThread) {
          await this.sendReply(acct, auth, {
            to: fromEmail,
            subject: header('Subject'),
            messageId: header('Message-ID'),
            threadId: msg.threadId,
            token,
          });
        }
      }
    }
    if (rescued) this.logger.log(`Warm-up: rescued ${rescued} mail(s) from spam for ${acct.email}`);
  }

  /** Threaded plain-text reply, minimal Gmail-native headers. */
  private async sendReply(
    acct: PoolAccount,
    auth: Record<string, string>,
    opts: { to: string; subject: string; messageId: string; threadId: string; token: string },
  ): Promise<void> {
    const subject = /^re:/i.test(opts.subject) ? opts.subject : `Re: ${opts.subject}`;
    const body = `${spin(REPLIES[Math.floor(Math.random() * REPLIES.length)])}\n\n[${opts.token}]`;

    const lines = [
      'MIME-Version: 1.0',
      `From: ${acct.email}`,
      `To: ${opts.to}`,
      `Subject: ${subject}`,
      ...(opts.messageId ? [`In-Reply-To: ${opts.messageId}`, `References: ${opts.messageId}`] : []),
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ].join('\r\n');

    const res = await fetch(`${GMAIL_API}/messages/send`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(lines, 'utf8').toString('base64url'), threadId: opts.threadId }),
    });
    if (res.ok) this.logger.log(`Warm-up reply sent: ${acct.email} → ${opts.to}`);
    else this.logger.warn(`Warm-up reply failed for ${acct.email}: ${res.status}`);
  }
}
