import { Injectable, Logger } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { SecretsService } from '@/modules/vault/secrets.service';
import { GoogleOAuthService } from '@/modules/integrations/google-oauth.service';
import { EmailDriver, EmailSendContext } from './email-driver.interface';

const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** Encode a header value that may contain non-ASCII (RFC 2047). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Derive a human display name from an email local-part (deliverability signal). */
function displayName(email: string): string {
  const local = (email.split('@')[0] || '').replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : email.split('@')[0];
}

/** Escape text for safe HTML embedding. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Real email sending via the Gmail API, on behalf of the workspace's connected
 * mailbox. Loads the mailbox's encrypted refresh token, mints an access token,
 * and sends a MIME message — from the user's own Gmail, so it inherits Google's
 * sending reputation (no proxy, no browser).
 */
@Injectable()
export class GmailDriver implements EmailDriver {
  private readonly logger = new Logger(GmailDriver.name);

  constructor(
    private readonly secrets: SecretsService,
    private readonly oauth: GoogleOAuthService,
  ) {}

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    ctx?: EmailSendContext,
  ): Promise<{ status: 'sent' | 'failed'; externalId?: string; error?: string }> {
    // Resolve the sending mailbox under the workspace's RLS context.
    const read = <T>(fn: (db: any) => Promise<T>): Promise<T> =>
      ctx?.workspaceId ? withWorkspace(ctx.workspaceId, fn) : fn(getDb());

    let acct: any;
    if (ctx?.emailAccountId) {
      acct = await read((db) =>
        db.selectFrom('email_accounts').selectAll().where('id', '=', ctx.emailAccountId).executeTakeFirst(),
      );
    } else if (ctx?.workspaceId) {
      acct = await read((db) =>
        db
          .selectFrom('email_accounts')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('provider', '=', 'gmail')
          .where('status', '=', 'active')
          .limit(1)
          .executeTakeFirst(),
      );
    }

    if (!acct?.credentials_secret_id) {
      return { status: 'failed', error: 'NO_MAILBOX: Gmail not connected for this workspace' };
    }

    try {
      const refresh = await this.secrets.decrypt(acct.credentials_secret_id, {
        workspaceId: acct.workspace_id,
      });
      const accessToken = await this.oauth.accessTokenFromRefresh(refresh);

      const raw = this.buildRawMessage(acct.email, to, subject, body, acct.from_name);
      const res = await fetch(GMAIL_SEND, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { status: 'failed', error: `Gmail send ${res.status}: ${text.slice(0, 300)}` };
      }
      const data: any = await res.json();
      return { status: 'sent', externalId: data.id };
    } catch (err: any) {
      return { status: 'failed', error: String(err?.message || err) };
    }
  }

  /**
   * Build a base64url-encoded RFC 822 message tuned for inbox placement:
   *  - real From display name + Reply-To (not a bare address)
   *  - Message-ID + Date
   *  - List-Unsubscribe (+ One-Click) — Gmail weighs this heavily for cold mail
   *  - multipart/alternative (plain + HTML) with an unsubscribe footer
   */
  private buildRawMessage(
    from: string,
    to: string,
    subject: string,
    body: string,
    fromName?: string,
  ): string {
    const name = encodeHeader(fromName || displayName(from));
    const domain = from.split('@')[1] || 'mail.local';
    const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${domain}>`;
    const unsubMailto = `mailto:${from}?subject=unsubscribe`;

    const isHtml = /<[a-z][\s\S]*>/i.test(body);
    // Derive both representations from whatever we were given.
    const plain = (isHtml ? body.replace(/<[^>]+>/g, '') : body).trim();
    const htmlBody = isHtml
      ? body
      : `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${escapeHtml(plain).replace(/\n/g, '<br>')}</div>`;

    const footerPlain = `\r\n\r\n—\r\nDon't want these emails? Unsubscribe: ${unsubMailto}`;
    const footerHtml = `<p style="margin-top:24px;color:#8a8a8a;font-size:12px">Don't want these emails? <a href="${unsubMailto}" style="color:#8a8a8a">Unsubscribe</a>.</p>`;

    const boundary = `rp_${Math.random().toString(36).slice(2)}`;
    const headers = [
      `From: ${name} <${from}>`,
      `To: ${to}`,
      `Reply-To: ${from}`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      // mailto-only List-Unsubscribe. One-Click (List-Unsubscribe-Post) is
      // intentionally omitted — RFC 8058 requires an https:// URI for it, which
      // needs a public unsubscribe endpoint (add in production, not localhost).
      `List-Unsubscribe: <${unsubMailto}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];

    const message = [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      plain + footerPlain,
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      htmlBody + footerHtml,
      `--${boundary}--`,
      '',
    ].join('\r\n');

    return Buffer.from(message, 'utf8').toString('base64url');
  }
}
