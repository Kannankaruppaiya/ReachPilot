import { Injectable } from '@nestjs/common';
import {
  LinkedInDriver,
  LinkedInActionContext,
  LinkedInActionResult,
  LinkedInLoginContext,
  LinkedInLoginResult,
  LinkedInSyncResult,
} from './linkedin-driver.interface';
import { EmailDriver } from './email-driver.interface';
import { withWorkspace } from '@/db/rls';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeId = (p: string) => p + Math.random().toString(36).slice(2, 9);

/**
 * Fake driver for dev/tests — never contacts LinkedIn. It mirrors the *shape* of
 * the real driver: every action resolves to a classified outcome, and
 * `syncAccount` is read-only (returns observations; the worker applies DB
 * writes), exactly like the Playwright driver. That parity means the worker's
 * dispatch + sync flow is exercised identically whichever driver is selected.
 */
@Injectable()
export class SimulatorDriver implements LinkedInDriver, EmailDriver {
  async sendConnectRequest(): Promise<LinkedInActionResult> {
    await delay(1200);
    return { status: 'sent', externalId: fakeId('li_inv_') };
  }

  async sendMessage(): Promise<LinkedInActionResult> {
    await delay(1000);
    return { status: 'sent', externalId: fakeId('li_msg_') };
  }

  async visitProfile(): Promise<LinkedInActionResult> {
    await delay(700);
    return { status: 'sent', externalId: fakeId('li_view_') };
  }

  async follow(): Promise<LinkedInActionResult> {
    await delay(700);
    return { status: 'sent', externalId: fakeId('li_follow_') };
  }

  async sendInMail(): Promise<LinkedInActionResult> {
    await delay(1000);
    return { status: 'sent', externalId: fakeId('li_inmail_') };
  }

  async likeRecentPost(): Promise<LinkedInActionResult> {
    await delay(600);
    return { status: 'sent', externalId: fakeId('li_like_') };
  }

  async endorseSkill(): Promise<LinkedInActionResult> {
    await delay(600);
    return { status: 'sent', externalId: fakeId('li_endorse_') };
  }

  /** Fake login — returns a stub cookie so the login flow works end-to-end in dev. */
  async login(ctx: LinkedInLoginContext): Promise<LinkedInLoginResult> {
    await delay(1200);
    return { status: 'connected', li_at: 'sim_li_at_' + Math.random().toString(36).slice(2, 18), fingerprint: ctx.fingerprint };
  }

  async sendEmail(): Promise<{ status: 'sent' | 'failed'; externalId?: string; error?: string }> {
    await delay(800);
    return { status: 'sent', externalId: fakeId('em_msg_') };
  }

  /**
   * Read-only simulated sync: promotes a share of `invited` leads to "accepted"
   * and a share of already-`accepted` leads to "replied", returning them as
   * observations. The worker applies the state changes — so a lead progresses
   * invited → accepted → replied across successive sync passes, just like prod.
   */
  async syncAccount(ctx?: LinkedInActionContext): Promise<LinkedInSyncResult> {
    const wsId = ctx?.workspaceId;
    if (!wsId) return { accepted: [], replies: [] };

    const accepted: LinkedInSyncResult['accepted'] = [];
    const replies: LinkedInSyncResult['replies'] = [];

    const invited = await withWorkspace(wsId, (db) =>
      db.selectFrom('leads').select(['linkedin_url']).where('status', '=', 'invited').where('linkedin_url', 'is not', null).limit(50).execute(),
    ).catch(() => [] as any[]);
    for (const l of invited) {
      if (l.linkedin_url && Math.random() < 0.35) accepted.push({ profileUrl: l.linkedin_url });
    }

    const acceptedLeads = await withWorkspace(wsId, (db) =>
      db.selectFrom('leads').select(['linkedin_url', 'full_name']).where('status', '=', 'accepted').where('linkedin_url', 'is not', null).limit(50).execute(),
    ).catch(() => [] as any[]);
    for (const l of acceptedLeads) {
      if (l.linkedin_url && Math.random() < 0.15) {
        replies.push({
          profileUrl: l.linkedin_url,
          fromName: l.full_name,
          text: 'Thanks for reaching out! Happy to chat next week — send me a few slots.',
          externalId: fakeId('sim_reply_'),
        });
      }
    }

    return { accepted, replies };
  }

  async withdrawStaleInvites(): Promise<{ withdrawn: number }> {
    await delay(300);
    return { withdrawn: 0 };
  }
}
