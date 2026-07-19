/**
 * End-to-end verification of the scheduler backbone against the live DB + Redis.
 * Creates a throwaway workspace, seeds three due `scheduled` jobs exercising each
 * gate, runs one scheduler tick, asserts the outcomes, then cleans everything up.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/verify-scheduler.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { SchedulerService } from '../src/modules/engine/scheduler.service';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { randomUUID } from 'crypto';

const past = () => new Date(Date.now() - 60_000).toISOString(); // 1 min ago = due

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const scheduler = app.get(SchedulerService);
  const db = getDb();

  const wsId = randomUUID();
  const results: string[] = [];
  let pass = true;
  const check = (name: string, ok: boolean, detail: string) => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    if (!ok) pass = false;
  };

  try {
    // --- Seed a throwaway tenant ---
    await db.insertInto('workspaces').values({ id: wsId, name: 'scheduler-verify' } as any).execute();

    const pausedAcctId = randomUUID();
    const blacklistedLeadId = randomUUID();
    await withWorkspace(wsId, async (t) => {
      await t
        .insertInto('linkedin_accounts')
        .values({ id: pausedAcctId, workspace_id: wsId, email: 'paused@verify.test', country: 'US', status: 'paused' } as any)
        .execute();
      await t
        .insertInto('leads')
        .values({ id: blacklistedLeadId, workspace_id: wsId, first_name: 'Do', full_name: 'Do NotContact', status: 'blacklisted' } as any)
        .execute();
    });

    // A) plain due job (no account, no lead) → should ENQUEUE (status queued)
    const jobA = randomUUID();
    // B) due job for a PAUSED account → should DEFER (stays scheduled, future time)
    const jobB = randomUUID();
    // C) due job for a BLACKLISTED lead → should SUPPRESS (status canceled)
    const jobC = randomUUID();

    await withWorkspace(wsId, async (t) => {
      await t.insertInto('jobs').values({ id: jobA, workspace_id: wsId, kind: 'linkedin', action: 'connect_request', status: 'scheduled', scheduled_for: past() as any, payload: JSON.stringify({ name: 'A', target: 'https://linkedin.com/in/a' }) } as any).execute();
      await t.insertInto('jobs').values({ id: jobB, workspace_id: wsId, kind: 'linkedin', action: 'connect_request', status: 'scheduled', scheduled_for: past() as any, linkedin_account_id: pausedAcctId, payload: JSON.stringify({ name: 'B', target: 'https://linkedin.com/in/b' }) } as any).execute();
      await t.insertInto('jobs').values({ id: jobC, workspace_id: wsId, kind: 'linkedin', action: 'connect_request', status: 'scheduled', scheduled_for: past() as any, lead_id: blacklistedLeadId, payload: JSON.stringify({ name: 'C', target: 'https://linkedin.com/in/c' }) } as any).execute();
    });

    // --- Run one tick ---
    const totals = await scheduler.tick();

    // --- Assert ---
    const rows = await withWorkspace(wsId, (t) =>
      t.selectFrom('jobs').select(['id', 'status', 'scheduled_for', 'last_error']).where('workspace_id', '=', wsId).execute(),
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    check('A enqueued', byId[jobA]?.status === 'queued', `status=${byId[jobA]?.status} (want queued)`);
    check(
      'B deferred (paused account)',
      byId[jobB]?.status === 'scheduled' && new Date(byId[jobB]?.scheduled_for as any).getTime() > Date.now(),
      `status=${byId[jobB]?.status} scheduled_for=${byId[jobB]?.scheduled_for} err=${byId[jobB]?.last_error}`,
    );
    check('C suppressed (blacklisted lead)', byId[jobC]?.status === 'canceled', `status=${byId[jobC]?.status} err=${byId[jobC]?.last_error}`);
    check('tick totals', totals.enqueued >= 1 && totals.deferred >= 1 && totals.suppressed >= 1, JSON.stringify(totals));

    // Idempotency: a second tick must NOT re-enqueue A (it's queued now, not scheduled).
    const totals2 = await scheduler.tick();
    check('second tick no double-enqueue of A', totals2.enqueued === 0, `enqueued=${totals2.enqueued}`);
  } finally {
    // --- Clean up (jobs → children → workspace) ---
    await withWorkspace(wsId, (t) => t.deleteFrom('jobs').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('linkedin_accounts').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await withWorkspace(wsId, (t) => t.deleteFrom('leads').where('workspace_id', '=', wsId).execute()).catch(() => {});
    await getDb().deleteFrom('workspaces').where('id', '=', wsId).execute().catch(() => {});
    await app.close();
  }

  console.log('\n=== Scheduler verification ===');
  results.forEach((r) => console.log(r));
  console.log(`\n${pass ? '✅ ALL PASS' : '❌ FAILURES'}\n`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed:', err);
  process.exit(1);
});
