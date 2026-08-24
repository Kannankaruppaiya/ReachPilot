/**
 * Verifies the account-safety layers added for Expandi-parity:
 *  A. Inter-action spacing — a 2nd action immediately after the 1st is deferred.
 *  B. Warm-up ramp — a day-0 account's daily cap is small (~5), not the target.
 *  C. Daily-cap determinism — same account/day yields the same cap.
 *  D. Duplicate-invite guard — a 2nd connect request to an invited lead is cancelled.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/verify-safety.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PacingService } from '../src/modules/engine/pacing.service';
import { SchedulerService } from '../src/modules/engine/scheduler.service';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { getEnv } from '../src/config/env';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const pacing = app.get(PacingService);
  const scheduler = app.get(SchedulerService);
  const db = getDb();
  const redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });

  const results: string[] = [];
  let pass = true;
  const check = (n: string, ok: boolean, d = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!ok) pass = false; };

  const wsId = randomUUID();
  const acctId = randomUUID();
  const leadId = randomUUID();

  const clearPacing = async () => {
    const keys = await redis.keys(`pacing:linkedin:${acctId}:*`);
    if (keys.length) await redis.del(...keys);
  };

  try {
    await db.insertInto('workspaces').values({ id: wsId, name: 'safety-verify' } as any).execute();
    await withWorkspace(wsId, (t) =>
      t.insertInto('linkedin_accounts').values({
        id: acctId, workspace_id: wsId, email: 'safe@verify.test', country: 'US',
        status: 'warming_up', timezone: 'UTC', hours_start: '00:00', hours_end: '23:59',
        send_weekends: true, warmup_daily_limit: 21, warmup_target: 21,
        connected_at: new Date().toISOString(), // age 0 → ramp start
      } as any).execute(),
    );

    // A. Inter-action spacing
    await clearPacing();
    const first = await pacing.checkPacingAndRegister(acctId, 'linkedin', wsId, false);
    const second = await pacing.checkPacingAndRegister(acctId, 'linkedin', wsId, false);
    check('spacing: 1st allowed', first.allowed === true);
    check('spacing: 2nd deferred', second.allowed === false && !!second.nextScheduledAt, `next=${second.nextScheduledAt}`);

    // B. Warm-up ramp (day-0 cap should be ~5, far below target 21)
    await clearPacing();
    let allowedCount = 0;
    for (let i = 0; i < 30; i++) {
      await redis.del(`pacing:linkedin:${acctId}:nextallowed`); // bypass spacing to probe daily cap
      const r = await pacing.checkPacingAndRegister(acctId, 'linkedin', wsId, false);
      if (r.allowed) allowedCount++; else break;
    }
    check('warm-up ramp: day-0 cap small', allowedCount >= 3 && allowedCount <= 7, `cap=${allowedCount} (expected ~5, not 21)`);

    // C. Determinism — re-probe same day yields the same cap
    await clearPacing();
    let cap2 = 0;
    for (let i = 0; i < 30; i++) {
      await redis.del(`pacing:linkedin:${acctId}:nextallowed`);
      const r = await pacing.checkPacingAndRegister(acctId, 'linkedin', wsId, false);
      if (r.allowed) cap2++; else break;
    }
    check('daily cap deterministic', cap2 === allowedCount, `run1=${allowedCount} run2=${cap2}`);

    // D. Duplicate-invite guard (scheduler)
    await withWorkspace(wsId, async (t) => {
      await t.insertInto('leads').values({ id: leadId, workspace_id: wsId, first_name: 'Dup', full_name: 'Dup Lead', status: 'accepted' } as any).execute();
      // Prior invite already SENT to this lead
      await t.insertInto('jobs').values({ id: randomUUID(), workspace_id: wsId, kind: 'linkedin', action: 'connect_request', status: 'sent', scheduled_for: new Date().toISOString() as any, lead_id: leadId, linkedin_account_id: acctId, payload: JSON.stringify({ name: 'Dup' }) } as any).execute();
    });
    const dupJobId = randomUUID();
    await withWorkspace(wsId, (t) =>
      t.insertInto('jobs').values({ id: dupJobId, workspace_id: wsId, kind: 'linkedin', action: 'connect_request', status: 'scheduled', scheduled_for: new Date(Date.now() - 60000).toISOString() as any, lead_id: leadId, linkedin_account_id: acctId, payload: JSON.stringify({ name: 'Dup' }) } as any).execute(),
    );
    await scheduler.tick();
    const dupRow = await withWorkspace(wsId, (t) => t.selectFrom('jobs').select(['status', 'last_error']).where('id', '=', dupJobId).executeTakeFirst());
    check('duplicate-invite guard', dupRow?.status === 'canceled' && dupRow?.last_error === 'duplicate_invite', `status=${dupRow?.status} err=${dupRow?.last_error}`);
  } finally {
    await clearPacing().catch(() => {});
    await redis.quit().catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('jobs').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('leads').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('linkedin_accounts').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await db.deleteFrom('workspaces').where('id', '=', wsId).execute().catch(() => {});
    await app.close();
  }

  console.log('\n=== Account-safety verification ===');
  results.forEach((r) => console.log(r));
  console.log(`\n${pass ? '✅ ALL PASS' : '❌ FAILURES'}\n`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('verify crashed:', e); process.exit(1); });
