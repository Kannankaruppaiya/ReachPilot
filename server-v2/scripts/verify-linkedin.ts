/**
 * Verifies (1) every LinkedIn action type maps to a real driver method that
 * resolves to a classified outcome, and (2) the B4 sync-apply lifecycle:
 * invited → accepted → replied, with idempotent reply ingestion.
 * Runs against the live DB using the simulator driver.
 *
 *   LINKEDIN_DRIVER=simulator npx ts-node -r tsconfig-paths/register scripts/verify-linkedin.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { LINKEDIN_DRIVER } from '../src/modules/drivers/driver.tokens';
import { LinkedInDriver } from '../src/modules/drivers/linkedin-driver.interface';
import { LinkedInSyncService } from '../src/modules/drivers/linkedin-sync.service';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { randomUUID } from 'crypto';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const driver = app.get<LinkedInDriver>(LINKEDIN_DRIVER);
  const sync = app.get(LinkedInSyncService);
  const db = getDb();

  const results: string[] = [];
  let pass = true;
  const check = (name: string, ok: boolean, detail = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) pass = false;
  };

  const wsId = randomUUID();
  const acctId = randomUUID();
  const leadId = randomUUID();
  const slug = 'verify-jane-' + wsId.slice(0, 8);
  const profileUrl = `https://www.linkedin.com/in/${slug}`;

  try {
    // ---- (1) Dispatch completeness: every action routes to a real method ----
    const url = 'https://www.linkedin.com/in/someone';
    const calls: Record<string, () => Promise<any>> = {
      connect_request: () => driver.sendConnectRequest(url, 'hi', {}),
      linkedin_message: () => driver.sendMessage(url, 'hi', {}),
      inmail: () => driver.sendInMail(url, 'subj', 'hi', {}),
      follow: () => driver.follow(url, {}),
      visit_profile: () => driver.visitProfile(url, {}),
      like_post: () => driver.likeRecentPost(url, {}),
      endorse_skill: () => driver.endorseSkill(url, {}),
    };
    for (const [action, fn] of Object.entries(calls)) {
      const r = await fn();
      check(`dispatch ${action}`, r && r.status === 'sent', `status=${r?.status}`);
    }
    // sync + withdraw methods exist and return the right shape
    const syncShape = await driver.syncAccount({});
    check('syncAccount shape', Array.isArray(syncShape.accepted) && Array.isArray(syncShape.replies));
    const wd = await driver.withdrawStaleInvites(21, {});
    check('withdrawStaleInvites shape', typeof wd.withdrawn === 'number');

    // ---- (2) B4 apply lifecycle against the DB ----
    await db.insertInto('workspaces').values({ id: wsId, name: 'li-verify' } as any).execute();
    await withWorkspace(wsId, async (t) => {
      await t.insertInto('linkedin_accounts').values({ id: acctId, workspace_id: wsId, email: 'li@verify.test', country: 'US', status: 'warming_up' } as any).execute();
      await t.insertInto('leads').values({ id: leadId, workspace_id: wsId, first_name: 'Jane', full_name: 'Jane Verify', linkedin_url: profileUrl, status: 'invited' } as any).execute();
    });

    // Accepted: invited → accepted
    const a1 = await sync.apply(wsId, acctId, { accepted: [{ profileUrl }], replies: [] });
    const afterAccept = await withWorkspace(wsId, (t) => t.selectFrom('leads').select('status').where('id', '=', leadId).executeTakeFirst());
    check('accepted applied', a1.accepted === 1 && afterAccept?.status === 'accepted', `count=${a1.accepted} status=${afterAccept?.status}`);

    // Re-apply accepted is a no-op (lead no longer 'invited')
    const a2 = await sync.apply(wsId, acctId, { accepted: [{ profileUrl }], replies: [] });
    check('accepted idempotent', a2.accepted === 0, `count=${a2.accepted}`);

    // Reply: accepted → replied (+ thread + message)
    const ext = 'verify_reply_' + wsId.slice(0, 8);
    const r1 = await sync.apply(wsId, acctId, { accepted: [], replies: [{ profileUrl, text: 'Sure, send times', externalId: ext }] });
    const afterReply = await withWorkspace(wsId, (t) => t.selectFrom('leads').select('status').where('id', '=', leadId).executeTakeFirst());
    const msgCount1 = await db.selectFrom('messages').select(db.fn.countAll().as('c')).where('external_id', '=', ext).executeTakeFirst();
    check('reply applied', r1.replies === 1 && afterReply?.status === 'replied' && Number(msgCount1?.c) === 1, `count=${r1.replies} status=${afterReply?.status} msgs=${msgCount1?.c}`);

    // Re-apply same reply is idempotent (same externalId → no 2nd message)
    const r2 = await sync.apply(wsId, acctId, { accepted: [], replies: [{ profileUrl, text: 'Sure, send times', externalId: ext }] });
    const msgCount2 = await db.selectFrom('messages').select(db.fn.countAll().as('c')).where('external_id', '=', ext).executeTakeFirst();
    check('reply idempotent', r2.replies === 0 && Number(msgCount2?.c) === 1, `count=${r2.replies} msgs=${msgCount2?.c}`);
  } finally {
    // Cleanup (messages via thread ids first — not RLS'd)
    const threadIds = await withWorkspace(wsId, (t) => t.selectFrom('threads').select('id').where('workspace_id', '=', wsId).execute()).catch(() => []);
    for (const th of threadIds) await db.deleteFrom('messages').where('thread_id', '=', th.id).execute().catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('threads').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('activity').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('daily_stats').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('leads').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('linkedin_accounts').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await db.deleteFrom('workspaces').where('id', '=', wsId).execute().catch(() => {});
    await app.close();
  }

  console.log('\n=== LinkedIn dispatch + sync verification ===');
  results.forEach((r) => console.log(r));
  console.log(`\n${pass ? '✅ ALL PASS' : '❌ FAILURES'}\n`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed:', err);
  process.exit(1);
});
