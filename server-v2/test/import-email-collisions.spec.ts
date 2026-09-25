/**
 * Lead import must not abort because two rows share an email.
 *
 * Reproduced against a local database before the fix — each of these rolled back
 * the ENTIRE import, not just the offending row:
 *   - two email-only rows with one address → "ON CONFLICT DO UPDATE command
 *     cannot affect row a second time"
 *   - two LinkedIn profiles with one address → duplicate key on leads_dedup_email
 *
 * REQUIREMENTS: local Postgres. SKIPS otherwise.
 */
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { LeadsService } from '@/modules/leads/leads.service';
import { assertLocalServices } from './local-only';

const WS = '00000000-0000-0000-0000-0000000000a1';

let reachable = false;
let skipReason = '';
const leads = new LeadsService();

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
  await getDb().insertInto('workspaces').values({ id: WS, name: 'import-collisions' }).execute();
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

const allLeads = () =>
  withWorkspace(WS, (db) =>
    db
      .selectFrom('leads')
      .select(['full_name', 'email', 'linkedin_slug', 'email_verified'])
      .orderBy('full_name')
      .execute(),
  );

describe('importLeads with colliding emails', () => {
  t('two email-only rows with the same address import as one lead', async () => {
    const res = await leads.importLeads(WS, 'csv', [
      { name: 'A One', email: 'a@x.com' },
      { name: 'A Two', email: 'A@X.com' },
      { name: 'B', email: 'b@x.com' },
    ]);

    expect(res.count).toBe(2);
    expect((await allLeads()).map((l) => l.email)).toEqual(['a@x.com', 'b@x.com']);
  });

  t('two profiles sharing an address both import; only the first keeps it', async () => {
    await leads.importLeads(WS, 'csv', [
      { name: 'B One', linkedinUrl: 'linkedin.com/in/b-one', email: 'shared@x.com' },
      { name: 'B Two', linkedinUrl: 'linkedin.com/in/b-two', email: 'shared@x.com' },
    ]);

    expect(await allLeads()).toEqual([
      { full_name: 'B One', email: 'shared@x.com', linkedin_slug: 'b-one', email_verified: true },
      { full_name: 'B Two', email: null, linkedin_slug: 'b-two', email_verified: false },
    ]);
  });

  t('a profile does not take an address an existing lead already holds', async () => {
    await leads.importLeads(WS, 'csv', [{ name: 'Mail Only', email: 'taken@x.com' }]);

    await leads.importLeads(WS, 'scrape', [
      { name: 'Profile', linkedinUrl: 'https://www.linkedin.com/in/profile', email: 'TAKEN@x.com' },
      { name: 'Other', linkedinUrl: 'https://www.linkedin.com/in/other', email: 'free@x.com' },
    ]);

    expect(await allLeads()).toEqual([
      { full_name: 'Mail Only', email: 'taken@x.com', linkedin_slug: null, email_verified: true },
      { full_name: 'Other', email: 'free@x.com', linkedin_slug: 'other', email_verified: true },
      { full_name: 'Profile', email: null, linkedin_slug: 'profile', email_verified: false },
    ]);
  });

  t('re-importing the same profile with its own address is not a collision', async () => {
    const row = { name: 'Same', linkedinUrl: 'linkedin.com/in/same', email: 'same@x.com' };
    await leads.importLeads(WS, 'csv', [row]);
    await leads.importLeads(WS, 'csv', [{ ...row, name: 'Same Renamed' }]);

    expect(await allLeads()).toEqual([
      { full_name: 'Same Renamed', email: 'same@x.com', linkedin_slug: 'same', email_verified: true },
    ]);
  });

  t('an email-only row matching a profile in the same file updates that lead', async () => {
    const res = await leads.importLeads(WS, 'csv', [
      { name: 'Both', linkedinUrl: 'linkedin.com/in/both', email: 'both@x.com' },
      { name: 'Both From Mail', email: 'both@x.com' },
    ]);

    expect(res.count).toBe(2); // one insert + one update of the same lead
    expect(await allLeads()).toEqual([
      { full_name: 'Both From Mail', email: 'both@x.com', linkedin_slug: 'both', email_verified: true },
    ]);
  });
});
