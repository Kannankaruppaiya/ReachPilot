/**
 * A LinkedIn reply from the inbox is recorded only if it was actually sent.
 *
 * sendMessage used to call the LinkedIn driver with no account and ignore the
 * result. In production (remote driver) a call without an account fails at once
 * with `no_account_id` — yet the message was saved as sent and the thread marked
 * read, so the user believed they had answered the prospect.
 *
 * REQUIREMENTS: local Postgres. SKIPS otherwise. The driver and the session
 * builder are stubs — nothing reaches LinkedIn or a desktop agent.
 */
import { randomUUID } from 'crypto';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { InboxService } from '@/modules/inbox/inbox.service';
import { assertLocalServices } from './local-only';

const WS = '00000000-0000-0000-0000-000000000081';
const ACCT_A = '00000000-0000-0000-0000-000000000082';
const ACCT_B = '00000000-0000-0000-0000-000000000083';

let reachable = false;
let skipReason = '';

beforeAll(async () => {
  try {
    assertLocalServices(getEnv());
    reachable = true;
  } catch (e: any) {
    skipReason = e.message;
  }
}, 60_000);

beforeEach(async () => {
  if (!reachable) return;
  await getDb().deleteFrom('workspaces').where('id', '=', WS).execute();
  await getDb().insertInto('workspaces').values({ id: WS, name: 'inbox-li-reply' }).execute();
  await withWorkspace(WS, (db) =>
    db
      .insertInto('linkedin_accounts')
      .values([
        // A is the newer account; B is the one that actually reached the lead.
        { id: ACCT_A, workspace_id: WS, email: 'a@test.local', country: 'IN', status: 'active', connected_at: new Date().toISOString() },
        { id: ACCT_B, workspace_id: WS, email: 'b@test.local', country: 'IN', status: 'active', connected_at: new Date(Date.now() - 86400_000).toISOString() },
      ])
      .execute(),
  );
}, 60_000);

afterAll(async () => {
  if (reachable) await getDb().deleteFrom('workspaces').where('id', '=', WS).execute();
  await getDb().destroy();
}, 60_000);

const t = (name: string, fn: () => Promise<void>) =>
  it(
    name,
    async () => {
      if (!reachable) {
        console.warn(`  ↳ skipped (${skipReason})`);
        return;
      }
      await fn();
    },
    60_000,
  );

/** A lead with an unread LinkedIn thread. */
async function linkedinThread(): Promise<{ leadId: string; threadId: string }> {
  const leadId = randomUUID();
  const threadId = randomUUID();
  await withWorkspace(WS, async (db) => {
    await db
      .insertInto('leads')
      .values({
        id: leadId,
        workspace_id: WS,
        full_name: 'Inbox Prospect',
        first_name: 'Inbox',
        linkedin_url: 'https://www.linkedin.com/in/inbox-prospect',
        status: 'replied',
        source: 'test',
      })
      .execute();
    await db
      .insertInto('threads')
      .values({ id: threadId, workspace_id: WS, lead_id: leadId, channel: 'linkedin', unread: true, last_message_at: new Date().toISOString() })
      .execute();
  });
  return { leadId, threadId };
}

/** Driver + session stubs that record what they were asked to do. */
function harness(result: any, opts: { noContext?: boolean } = {}) {
  const calls: { url: string; body: string; ctx: any }[] = [];
  const linkedin: any = {
    sendMessage: async (url: string, body: string, ctx: any) => {
      calls.push({ url, body, ctx });
      return result;
    },
  };
  const sessions: any = {
    buildActionContext: async (accountId: string, workspaceId: string) =>
      opts.noContext ? null : { accountId, workspaceId },
  };
  return { inbox: new InboxService({} as any, linkedin, sessions), calls };
}

const recorded = (threadId: string) =>
  withWorkspace(WS, async (db) => ({
    messages: await db.selectFrom('messages').select(['direction', 'body']).where('thread_id', '=', threadId).execute(),
    unread: (await db.selectFrom('threads').select('unread').where('id', '=', threadId).executeTakeFirstOrThrow()).unread,
  }));

describe('replying on LinkedIn from the inbox', () => {
  t('a failed send is reported and NOT recorded as sent', async () => {
    const th = await linkedinThread();
    const { inbox } = harness({ status: 'failed', error: 'agent_unavailable' });

    await expect(inbox.sendMessage(WS, th.threadId, 'Thanks!')).rejects.toThrow('desktop app is offline');

    expect(await recorded(th.threadId)).toEqual({ messages: [], unread: true });
  });

  t('a confirmed send is recorded, and went out AS a real account', async () => {
    const th = await linkedinThread();
    const { inbox, calls } = harness({ status: 'sent', externalId: 'li-msg-1' });

    await inbox.sendMessage(WS, th.threadId, 'Thanks!');

    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.accountId).toBeTruthy();
    expect(await recorded(th.threadId)).toEqual({ messages: [{ direction: 'me', body: 'Thanks!' }], unread: false });
  });

  t('replies from the account that reached the lead, not just the newest one', async () => {
    const th = await linkedinThread();
    await withWorkspace(WS, (db) =>
      db
        .insertInto('jobs')
        .values({
          workspace_id: WS,
          lead_id: th.leadId,
          linkedin_account_id: ACCT_B,
          kind: 'linkedin',
          action: 'connect_request',
          status: 'sent',
          sent_at: new Date().toISOString(),
          scheduled_for: new Date().toISOString(),
          payload: JSON.stringify({ name: 'Inbox Prospect' }),
        })
        .execute(),
    );
    const { inbox, calls } = harness({ status: 'sent' });

    await inbox.sendMessage(WS, th.threadId, 'Hello again');

    expect(calls[0].ctx.accountId).toBe(ACCT_B);
  });

  t('an unconfirmed send warns about sending twice and records nothing', async () => {
    const th = await linkedinThread();
    const { inbox } = harness({ status: 'failed', error: 'agent_result_pending' });

    await expect(inbox.sendMessage(WS, th.threadId, 'Thanks!')).rejects.toThrow('Check LinkedIn before sending it again');
    expect((await recorded(th.threadId)).messages).toEqual([]);
  });

  t('with every account paused nothing is attempted', async () => {
    const th = await linkedinThread();
    await withWorkspace(WS, (db) => db.updateTable('linkedin_accounts').set({ status: 'paused' }).where('workspace_id', '=', WS).execute());
    const { inbox, calls } = harness({ status: 'sent' });

    await expect(inbox.sendMessage(WS, th.threadId, 'Thanks!')).rejects.toThrow('Connect a LinkedIn account');
    expect(calls).toHaveLength(0);
  });

  t('an account with no usable session is refused before the driver runs', async () => {
    const th = await linkedinThread();
    const { inbox, calls } = harness({ status: 'sent' }, { noContext: true });

    await expect(inbox.sendMessage(WS, th.threadId, 'Thanks!')).rejects.toThrow('needs reconnecting');
    expect(calls).toHaveLength(0);
    expect((await recorded(th.threadId)).messages).toEqual([]);
  });
});
