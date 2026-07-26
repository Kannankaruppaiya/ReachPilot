import { randomBytes } from 'crypto';
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

// eslint-disable-next-line no-control-regex
const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s);

/**
 * Quoted-printable encode (RFC 2045) — the transfer encoding Gmail itself uses
 * for non-ASCII bodies, so our parts look exactly like Gmail-composed ones.
 */
function quotedPrintable(text: string): string {
  const bytes = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8');
  let out = '';
  let line = '';
  const push = (s: string) => {
    // Soft-wrap at 75 chars so no encoded line exceeds the RFC's 76 limit.
    if (line.length + s.length > 75) {
      out += line + '=\r\n';
      line = '';
    }
    line += s;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d && bytes[i + 1] === 0x0a) {
      out += line + '\r\n';
      line = '';
      i++;
      continue;
    }
    if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) {
      push(String.fromCharCode(b));
    } else {
      push('=' + b.toString(16).toUpperCase().padStart(2, '0'));
    }
  }
  return out + line;
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
      // No explicit mailbox on the job → the workspace's DEFAULT sender is the
      // most recently connected active mailbox (deterministic; without the
      // orderBy, Postgres returns an arbitrary row once there are several).
      acct = await read((db) =>
        db
          .selectFrom('email_accounts')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('provider', '=', 'gmail')
          .where('status', '=', 'active')
          .orderBy('connected_at', 'desc')
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
   * Build a base64url-encoded RFC 822 message that is indistinguishable from
   * one composed in the Gmail UI. Deliberately MINIMAL headers — no Message-ID,
   * Date, Reply-To, or List-Unsubscribe: Gmail assigns its own Message-ID/Date
   * on send, and the bulk-mail markers (unsubscribe header + footer, custom
   * message-id format, `rp_` boundary, styled HTML wrapper) were fingerprinting
   * us as a sending tool and hurting inbox placement (manual Gmail sends from
   * the same account landed in the inbox; ours went to spam).
   */
  private buildRawMessage(
    from: string,
    to: string,
    subject: string,
    body: string,
    fromName?: string,
  ): string {
    const name = encodeHeader(fromName || displayName(from));

    const isHtml = /<[a-z][\s\S]*>/i.test(body);
    // Derive both representations from whatever we were given. Plain-text
    // bodies get Gmail's own bare wrapper (`<div dir="ltr">`) — no inline
    // styles, which read as a mail-tool template.
    const plain = (isHtml ? body.replace(/<[^>]+>/g, '') : body).trim();
    const htmlBody = isHtml
      ? body
      : `<div dir="ltr">${escapeHtml(plain).replace(/\n/g, '<br>')}</div>`;

    // Gmail-style boundary: a run of zeros followed by hex.
    const boundary = `000000000000${randomBytes(6).toString('hex')}`;

    // Like Gmail: quoted-printable only when the content actually needs it.
    const part = (type: string, content: string): string[] => {
      if (isAscii(content)) {
        return [`Content-Type: ${type}; charset="UTF-8"`, '', content];
      }
      return [
        `Content-Type: ${type}; charset="UTF-8"`,
        'Content-Transfer-Encoding: quoted-printable',
        '',
        quotedPrintable(content),
      ];
    };

    const message = [
      'MIME-Version: 1.0',
      `From: ${name} <${from}>`,
      `To: ${to}`,
      `Subject: ${encodeHeader(subject)}`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      ...part('text/plain', plain),
      '',
      `--${boundary}`,
      ...part('text/html', htmlBody),
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    return Buffer.from(message, 'utf8').toString('base64url');
  }
}
