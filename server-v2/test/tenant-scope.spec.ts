/**
 * One tenant must never read or write another's rows — even while RLS is off.
 *
 * Production connects as a role that BYPASSES row-level security
 * (docs/TENANT_ISOLATION.md), so `withWorkspace` isolates nothing there: only an
 * explicit `workspace_id` filter does. These queries had none, and each one
 * crossed tenants in production:
 *   - the Leads screen listed every tenant's leads; PATCH /leads/:id edited any
 *   - saving LinkedIn limits (Settings, onboarding) rewrote EVERY tenant's accounts
 *   - connecting a LinkedIn email another tenant used overwrote THEIR account
 *   - each workspace's scheduler drain claimed every tenant's due jobs, and one
 *     tenant's sent invite cancelled another's as a "duplicate"
 *   - an Apify lookup could decrypt and spend another tenant's token
 *   - scrape history and the Connections page read other tenants' rows
 *
 * The local test user is a superuser, which bypasses RLS exactly like the
 * production role, so these tests see what production sees.
 *
 * REQUIREMENTS: local Postgres. SKIPS otherwise. The scheduler is drained for one
 * test workspace only; every drained job ends canceled or deferred.
 */
import { randomUUID } from 'crypto';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { LeadsService } from '@/modules/leads/leads.service';
import { LinkedinAccountsService } from '@/modules/accounts/linkedin-accounts.service';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { OnboardingService } from '@/modules/onboarding/onboarding.service';
import { SchedulerService } from '@/modules/engine/scheduler.service';
import { ScrapeJobsService } from '@/modules/scraping/scrape-jobs.service';
import { ApifyScrapeService } from '@/modules/ai/apify-scrape.service';
import { JobsService } from '@/modules/jobs/jobs.service';
import { SecretsService } from '@/modules/vault/secrets.service';
import { KeyManagementService } from '@/modules/vault/key-management.service';
import { AuditService } from '@/modules/audit/audit.service';
import { assertLocalServices } from './local-only';

const A = '00000000-0000-0000-0000-0000000000a7';
const B = '00000000-0000-0000-0000-0000000000b7';
const ACCT_A = '00000000-0000-0000-0000-0000000000a8';
const ACCT_B = '00000000-0000-0000-0000-0000000000b8';
const USER = '00000000-0000-0000-0000-0000000000c7';

let reachable = false;
let skipReason = '';
const secrets = new SecretsService(new KeyManagementService(), new AuditService());
const scheduler = new SchedulerService();

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
  await getDb().deleteFrom('workspaces').where('id', 'in', [A, B]).execute();
  await getDb()
    .insertInto('workspaces')
    .values([
      { id: A, name: 'tenant A' },
      { id: B, name: 'tenant B' },
    ])
    .execute();
  // users is not tenant-scoped; linkedin_accounts.owner_user_id references it.
  await getDb().deleteFrom('users').where('id', '=', USER).execute();
  await getDb().insertInto('users').values({ id: USER, email: 'tenant-scope@test.local', full_name: 'Scope' }).execute();
  for (const [ws, acct, email] of [
    [A, ACCT_A, 'a-owner@test.local'],
    [B, ACCT_B, 'b-owner@test.local'],
  ]) {
    await withWorkspace(ws, (db) =>
      db
        .insertInto('linkedin_accounts')
        .values({ id: acct, workspace_id: ws, email, country: 'IN', status: 'paused', warmup_daily_limit: 20, weekly_invite_cap: 100 })
        .execute(),
    );
  }
}, 60_000);

afterAll(async () => {
  if (reachable) {
    await getDb().deleteFrom('workspaces').where('id', 'in', [A, B]).execute();
    await getDb().deleteFrom('users').where('id', '=', USER).execute();
  }
  await (scheduler as any)?.redis?.quit?.().catch(() => undefined);
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

async function lead(ws: string, slug: string, status = 'new'): Promise<string> {
  const id = randomUUID();
  await withWorkspace(ws, (db) =>
    db
      .insertInto('leads')
      .values({
        id,
        workspace_id: ws,
        full_name: `Lead ${slug}`,
        first_name: 'Lead',
        linkedin_url: `https://www.linkedin.com/in/${slug}`,
        linkedin_slug: slug,
        status,
        source: 'test',
      })
      .execute(),
  );
  return id;
}

const account = (id: string) =>
  getDb()
    .selectFrom('linkedin_accounts')
    .select(['workspace_id', 'email', 'status', 'warmup_daily_limit', 'weekly_invite_cap', 'hours_start', 'password_secret_id'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('leads', () => {
  t('the Leads list shows only this workspace', async () => {
    await lead(A, 'a-lead');
    await lead(B, 'b-lead');

    const rows = await new LeadsService().list(A);

    expect(rows.map((r) => r.linkedinUrl)).toEqual(['https://www.linkedin.com/in/a-lead']);
  });

  t("PATCH cannot edit another workspace's lead", async () => {
    const theirs = await lead(B, 'b-lead');

    await expect(new LeadsService().update(A, theirs, { status: 'blacklisted' })).rejects.toThrow('Lead not found');

    const row = await getDb().selectFrom('leads').select('status').where('id', '=', theirs).executeTakeFirstOrThrow();
    expect(row.status).toBe('new');
  });
});

describe('LinkedIn accounts', () => {
  const service = () =>
    new LinkedinAccountsService(secrets, { assignProxy: async () => null } as any, new WorkspacesService());

  t("saving limits changes this workspace's account only", async () => {
    await service().updateLimits(A, 35, 80);

    expect(await account(ACCT_A)).toMatchObject({ warmup_daily_limit: 35, weekly_invite_cap: 80 });
    expect(await account(ACCT_B)).toMatchObject({ warmup_daily_limit: 20, weekly_invite_cap: 100 });
  });

  t("onboarding warm-up changes this workspace's account only", async () => {
    const onboarding = new OnboardingService(new WorkspacesService(), {} as any, {} as any);

    await onboarding.saveWarmup(A, 12, '10:00', '17:00', false);

    expect((await account(ACCT_A)).warmup_daily_limit).toBe(12);
    expect((await account(ACCT_B)).warmup_daily_limit).toBe(20);
  });

  t('connecting an email another workspace uses creates our own account, not a takeover', async () => {
    const theirsBefore = await account(ACCT_B);

    await service().connect(A, USER, 'b-owner@test.local', 'hunter2hunter2', 'IN');

    expect(await account(ACCT_B)).toEqual(theirsBefore);
    const ours = await withWorkspace(A, (db) =>
      db.selectFrom('linkedin_accounts').select('id').where('workspace_id', '=', A).where('email', '=', 'b-owner@test.local').execute(),
    );
    expect(ours).toHaveLength(1);
  });
});

describe('scheduler', () => {
  const connectJob = (ws: string, acct: string, target: string, status = 'scheduled') =>
    withWorkspace(ws, (db) =>
      db
        .insertInto('jobs')
        .values({
          workspace_id: ws,
          linkedin_account_id: acct,
          kind: 'linkedin',
          action: 'connect_request',
          status,
          scheduled_for: new Date(Date.now() - 60_000).toISOString(),
          payload: JSON.stringify({ name: 'x', target }),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
  const job = (id: string) =>
    getDb().selectFrom('jobs').select(['workspace_id', 'status', 'last_error']).where('id', '=', id).executeTakeFirstOrThrow();

  t("draining one workspace never touches another's due jobs", async () => {
    const theirs = await connectJob(B, ACCT_B, 'https://www.linkedin.com/in/someone');

    await (scheduler as any).drainWorkspace(A);

    expect(await job(theirs.id)).toEqual({ workspace_id: B, status: 'scheduled', last_error: null });
  });

  t("another workspace's sent invite does not cancel ours as a duplicate", async () => {
    await connectJob(B, ACCT_B, 'https://www.linkedin.com/in/shared-prospect', 'sent');
    const ours = await connectJob(A, ACCT_A, 'https://www.linkedin.com/in/shared-prospect');

    await (scheduler as any).drainWorkspace(A);

    // Held by our (paused) account's health gate — not canceled as a duplicate.
    expect(await job(ours.id)).toMatchObject({ status: 'scheduled', last_error: 'account_paused' });
  });
});

describe('integrations and history', () => {
  t("an Apify lookup never returns another workspace's token", async () => {
    const secretId = await secrets.encrypt('their-apify-token', 'integration_credentials', { workspaceId: B });
    await withWorkspace(B, (db) =>
      db.insertInto('integrations').values({ workspace_id: B, provider: 'apify', active: true, credentials_secret_id: secretId, config: '{}' }).execute(),
    );

    expect(await (new ApifyScrapeService(secrets) as any).token(A)).toBeNull();
    expect(await (new ApifyScrapeService(secrets) as any).token(B)).toBe('their-apify-token');
  });

  t('scrape history is per workspace', async () => {
    const jobs = new ScrapeJobsService();
    const theirs = await jobs.create(B, { titles: ['CFO'], maxResults: 10 });

    expect(await jobs.list(A)).toEqual([]);
    expect(await jobs.get(A, theirs)).toBeNull();
  });

  t("the Connections page reads outcomes from this workspace's leads only", async () => {
    await lead(B, 'shared-prospect', 'accepted');
    await withWorkspace(A, (db) =>
      db
        .insertInto('jobs')
        .values({
          workspace_id: A,
          kind: 'linkedin',
          action: 'connect_request',
          status: 'sent',
          sent_at: new Date().toISOString(),
          scheduled_for: new Date().toISOString(),
          payload: JSON.stringify({ name: 'x', target: 'https://www.linkedin.com/in/shared-prospect' }),
        })
        .execute(),
    );

    const res: any = await new JobsService().listConnections(A);

    expect(res.rows.map((r: any) => r.outcome)).toEqual(['pending']);
    expect(res.summary.accepted).toBe(0);
  });
});
