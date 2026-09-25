/**
 * Onboarding's Gmail step must not invent a mailbox, and senders must be real.
 *
 * The old step called /api/gmail/connect, which inserted an email_accounts row
 * with a hardcoded address, status 'active' and NO credentials into the
 * workspace, and reported success. Senders were picked with an unordered
 * limit(1), so when that placeholder came first every email failed NO_MAILBOX
 * although a real inbox was connected, and Integrations showed "connected".
 *
 * REQUIREMENTS: local Postgres. SKIPS otherwise. Nothing reaches Google: the
 * OAuth client is a stub that reports which credentials it was handed.
 */
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { EmailAccountsService } from '@/modules/accounts/email-accounts.service';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { CampaignsService } from '@/modules/campaigns/campaigns.service';
import { IntegrationsService } from '@/modules/integrations/integrations.service';
import { GmailDriver } from '@/modules/drivers/gmail.driver';
import { SecretsService } from '@/modules/vault/secrets.service';
import { KeyManagementService } from '@/modules/vault/key-management.service';
import { AuditService } from '@/modules/audit/audit.service';
import { assertLocalServices } from './local-only';

const WS = '00000000-0000-0000-0000-000000000091';

let reachable = false;
let skipReason = '';
const secrets = new SecretsService(new KeyManagementService(), new AuditService());
const email = new EmailAccountsService(new WorkspacesService());

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
  await getDb().insertInto('workspaces').values({ id: WS, name: 'onboarding-gmail', onboarding_step: 3 }).execute();
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

const mailboxes = () =>
  withWorkspace(WS, (db) => db.selectFrom('email_accounts').select(['id', 'email', 'daily_limit']).execute());

/** A placeholder row exactly as the old step made it — newer than the real one. */
async function placeholder(): Promise<string> {
  const row = await withWorkspace(WS, (db) =>
    db
      .insertInto('email_accounts')
      .values({ workspace_id: WS, provider: 'gmail', email: 'placeholder@example.com', status: 'active', connected_at: new Date().toISOString() })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** A mailbox connected through OAuth: it holds an encrypted refresh token. */
async function realMailbox(): Promise<string> {
  const secretId = await secrets.encrypt('real-refresh-token', 'email_oauth', { workspaceId: WS });
  const row = await withWorkspace(WS, (db) =>
    db
      .insertInto('email_accounts')
      .values({
        workspace_id: WS,
        provider: 'gmail',
        email: 'real@company.com',
        status: 'active',
        credentials_secret_id: secretId,
        connected_at: new Date(Date.now() - 86400_000).toISOString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}

const onboardingStep = async () =>
  Number((await getDb().selectFrom('workspaces').select('onboarding_step').where('id', '=', WS).executeTakeFirstOrThrow()).onboarding_step);

describe('onboarding Gmail step', () => {
  t('refuses to "connect" when no mailbox was connected through OAuth — and creates none', async () => {
    await expect(email.saveOnboardingLimit(WS, 80)).rejects.toThrow('Connect your Gmail account first');
    expect(await mailboxes()).toEqual([]);
    expect(await onboardingStep()).toBe(3);
  });

  t('skip finishes the step without inventing a mailbox', async () => {
    const res = await email.saveOnboardingLimit(WS, 80, { skip: true });

    expect(res.gmail).toBeNull();
    expect(await mailboxes()).toEqual([]);
    expect(await onboardingStep()).toBe(4);
  });

  t('saves the limit on the OAuth-connected mailbox, not a placeholder', async () => {
    const realId = await realMailbox();
    const fakeId = await placeholder();

    const res = await email.saveOnboardingLimit(WS, 80);

    expect(res.gmail).toEqual({ email: 'real@company.com', dailyLimit: 80 });
    const byId = new Map((await mailboxes()).map((m) => [m.id, m.daily_limit]));
    expect(byId.get(realId)).toBe(80);
    expect(byId.get(fakeId)).toBe(50); // untouched default
  });
});

describe('choosing a sender', () => {
  t('a new campaign sends from the real mailbox even when a newer placeholder exists', async () => {
    const realId = await realMailbox();
    await placeholder();

    const camp = await new CampaignsService().create(WS, { name: 'sender pick', steps: [{ kind: 'email', subject: 's', body: 'b' }] as any });

    const row = await withWorkspace(WS, (db) =>
      db.selectFrom('campaigns').select('email_account_id').where('id', '=', camp.id).executeTakeFirstOrThrow(),
    );
    expect(row.email_account_id).toBe(realId);
  });

  t('a job queued against the placeholder is sent from the real mailbox', async () => {
    await realMailbox();
    const fakeId = await placeholder();
    // Stub Google: report which refresh token we were handed, send nothing.
    const oauth: any = {
      accessTokenFromRefresh: async (refresh: string) => {
        throw new Error(`used:${refresh}`);
      },
    };

    const res = await new GmailDriver(secrets, oauth).sendEmail('lead@x.com', 'hi', 'body', {
      emailAccountId: fakeId,
      workspaceId: WS,
    });

    expect(res).toEqual({ status: 'failed', error: 'used:real-refresh-token' });
  });

  t('with no real mailbox at all the send fails clearly instead of using the placeholder', async () => {
    const fakeId = await placeholder();

    const res = await new GmailDriver(secrets, {} as any).sendEmail('lead@x.com', 'hi', 'body', {
      emailAccountId: fakeId,
      workspaceId: WS,
    });

    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/^NO_MAILBOX/);
  });

  t('Integrations does not report a placeholder as connected', async () => {
    await placeholder();
    const integrations = new IntegrationsService({} as any, secrets, {} as any);

    const res = await integrations.list(WS);

    expect(res.gmail.connected).toBe(false);
    expect(res.gmailAccounts.map((a: any) => a.connected)).toEqual([false]);
  });
});
