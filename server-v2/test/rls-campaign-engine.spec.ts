/**
 * Tenant code must work under a role RLS applies to. Runs as `rp_rls_probe`
 * (NOSUPERUSER NOBYPASSRLS), so a raw getDb() read of a tenant table returns
 * nothing and fails the test. Needs local Postgres + Redis whose user may CREATE
 * ROLE; skips otherwise.
 */
import type { Kysely } from 'kysely';
import { randomUUID } from 'crypto';
import { assertLocalServices } from './local-only';
import { rlsRoleUrl } from './rls-role';

const WS = '00000000-0000-0000-0000-0000000000f1';
const OTHER_WS = '00000000-0000-0000-0000-0000000000f2';
const USER = '00000000-0000-0000-0000-0000000000f3';

let reachable = false;
let skipReason = '';

// Load after DATABASE_URL points at the probe role: getEnv() and getDb() cache.
let getDb: () => Kysely<any>;
let withWorkspace: <T>(ws: string, fn: (db: Kysely<any>) => Promise<T>) => Promise<T>;
let CampaignsService: any;
let CampaignRunnerService: any;
let GraphExecutor: any;
let ConditionEvaluator: any;
let ApiKeysService: any;
let AuthGuard: any;
let NotificationsService: any;
let hashApiKey: (t: string) => string;

beforeAll(async () => {
  try {
    assertLocalServices(process.env);
    process.env.DATABASE_URL = await rlsRoleUrl(process.env.DATABASE_URL!);
  } catch (e: any) {
    skipReason = e.message;
    return;
  }
  ({ getDb } = require('@/db'));
  ({ withWorkspace } = require('@/db/rls'));
  ({ CampaignsService } = require('@/modules/campaigns/campaigns.service'));
  ({ CampaignRunnerService } = require('@/modules/engine/campaign-runner.service'));
  ({ GraphExecutor } = require('@/modules/engine/graph-executor'));
  ({ ConditionEvaluator } = require('@/modules/engine/condition-evaluator'));
  ({ ApiKeysService } = require('@/modules/apikeys/apikeys.service'));
  ({ AuthGuard } = require('@/common/auth.guard'));
  ({ NotificationsService } = require('@/modules/notifications/notifications.service'));
  ({ hashApiKey } = require('@/modules/apikeys/api-key-token'));

  // workspaces is not RLS'd; children cascade on delete.
  await getDb().deleteFrom('workspaces').where('id', 'in', [WS, OTHER_WS]).execute();
  await getDb()
    .insertInto('workspaces')
    .values([
      { id: WS, name: 'rls-engine' },
      { id: OTHER_WS, name: 'rls-engine-other' },
    ])
    .execute();
  // users is not RLS'd either; api_keys.created_by references it.
  await getDb().deleteFrom('users').where('id', '=', USER).execute();
  await getDb().insertInto('users').values({ id: USER, email: 'rls-engine@test.local', full_name: 'Rls' }).execute();
  reachable = true;
}, 60_000);

afterAll(async () => {
  if (!reachable) return;
  await getDb().deleteFrom('workspaces').where('id', 'in', [WS, OTHER_WS]).execute();
  await getDb().deleteFrom('users').where('id', '=', USER).execute();
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

async function seedLead(ws = WS): Promise<string> {
  const id = randomUUID();
  await withWorkspace(ws, (db) =>
    db
      .insertInto('leads')
      .values({
        id,
        workspace_id: ws,
        full_name: 'Rls Prospect',
        first_name: 'Rls',
        linkedin_url: `https://www.linkedin.com/in/rls-${id.slice(0, 8)}`,
        linkedin_slug: `rls-${id.slice(0, 8)}`,
        status: 'new',
        source: 'test',
      })
      .execute(),
  );
  return id;
}

describe('tenant-scoped code under a role subject to RLS', () => {
  t('the campaign runner finds and advances a due enrollment', async () => {
    const leadId = await seedLead();
    // wait 1 day → message: the job lands in the future, so nothing is enqueued.
    const camp = await new CampaignsService().create(WS, {
      name: 'rls runner',
      steps: [{ kind: 'wait', days: 1 }, { kind: 'message', body: 'hi {{firstName}}' }],
      leadIds: [leadId],
      launch: true,
    });

    const runner = new CampaignRunnerService(new GraphExecutor(new ConditionEvaluator()));
    const res = await (runner as any).drainWorkspace(WS);

    expect(res.advanced).toBe(1);
    const jobs = await withWorkspace(WS, (db) =>
      db.selectFrom('jobs').select(['status', 'lead_id', 'payload']).where('campaign_id', '=', camp.id).execute(),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('scheduled');
    expect(jobs[0].lead_id).toBe(leadId);
    const payload = typeof jobs[0].payload === 'string' ? JSON.parse(jobs[0].payload) : jobs[0].payload;
    expect(payload.message).toBe('hi Rls');
  });

  t('an API key authenticates, and names its own workspace', async () => {
    const { token } = await new ApiKeysService().create(WS, USER, 'rls key', []);
    const guard = new AuthGuard({} as any);
    const req: any = { headers: {} };

    await expect((guard as any).validateApiKey(token, req)).resolves.toBe(true);
    expect(req.user.workspaceId).toBe(WS);

    const listed = await new ApiKeysService().list(WS);
    expect(listed.find((k: any) => k.name === 'rls key')?.last_used_at).toBeTruthy();
  });

  t('an API key whose workspace part was edited is rejected', async () => {
    const { token } = await new ApiKeysService().create(WS, USER, 'tamper key', []);
    const forged = token.replace(/_[0-9a-f]{32}$/, `_${OTHER_WS.replace(/-/g, '')}`);
    const guard = new AuthGuard({} as any);

    await expect((guard as any).validateApiKey(forged, { headers: {} })).rejects.toThrow('Invalid API key');
  });

  t('a key minted before the workspace-carrying format still authenticates', async () => {
    const legacy = `rp_live_${'ab'.repeat(24)}`;
    await withWorkspace(WS, (db) =>
      db
        .insertInto('api_keys')
        .values({ workspace_id: WS, name: 'legacy', key_prefix: legacy.slice(0, 12), key_hash: hashApiKey(legacy), scopes: [] })
        .execute(),
    );
    const req: any = { headers: {} };

    await expect((new AuthGuard({} as any) as any).validateApiKey(legacy, req)).resolves.toBe(true);
    expect(req.user.workspaceId).toBe(WS);
  });

  t('notifications are stored and listed', async () => {
    const svc = new NotificationsService();
    await svc.emitEvent(WS, 'rls_probe', {}, true, 'hello under RLS');

    const rows = await svc.list(WS);
    expect(rows.map((r: any) => r.text)).toContain('hello under RLS');
    expect(await svc.list(OTHER_WS)).toHaveLength(0);
  });
});
