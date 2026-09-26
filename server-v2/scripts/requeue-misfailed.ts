/**
 * Re-drive connect jobs failed as `no_connect_button` by the old top-card
 * detection ("More" menu never opened; Pending not recognised). The fixed driver
 * then marks a pending invite as sent, sends a real invite if connectable, or
 * fails with an accurate reason.
 *
 * ⚠️ Re-driving a lead with no outstanding invite SENDS A REAL INVITE. Dry run by
 * default; --apply writes. Rebuild and restart the desktop app first, or the jobs
 * re-run on the old bundled driver.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/requeue-misfailed.ts [--apply] [jobId…]
 */
import { getDb } from '../src/db';
const { sql } = require('kysely');

const APPLY = process.argv.includes('--apply');
/**
 * Limit to these job ids; don't requeue the whole set blind. Only leads LinkedIn
 * already shows as Pending re-drive without sending anything.
 */
const ONLY = process.argv.filter((a) => /^[0-9a-f-]{36}$/i.test(a));

(async () => {
  const db: any = getDb();

  const rows = (
    await sql`
      select id, payload->>'name' nm, payload->>'target' target,
             to_char(scheduled_for at time zone 'Asia/Kolkata','MM-DD HH24:MI') sched
      from jobs
      where kind = 'linkedin'
        and action = 'connect_request'
        and status = 'failed'
        and last_error = 'no_connect_button'
      order by scheduled_for`.execute(db)
  ).rows as any[];

  console.log(`${rows.length} job(s) failed with no_connect_button:\n`);
  for (const r of rows) console.log(`  ${String(r.nm).padEnd(28)} last tried ${r.sched}`);

  if (!rows.length) {
    console.log('\nnothing to do');
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to requeue these ${rows.length}.`);
    console.log('Each one re-runs through the driver; ones whose invite never went out WILL send a real invite.');
    process.exit(0);
  }

  // Spread over the next hour; pacing still caps them at send time.
  const ids = ONLY.length ? rows.filter((r) => ONLY.includes(r.id)).map((r) => r.id) : rows.map((r) => r.id);
  if (ONLY.length && ids.length !== ONLY.length) {
    console.error(`\nrefusing: ${ONLY.length} id(s) given but only ${ids.length} matched a failed no_connect_button job.`);
    process.exit(1);
  }
  console.log(`\nrequeuing ${ids.length} of ${rows.length}${ONLY.length ? ' (explicit id list)' : ' (ALL)'}`);
  const res = await sql`
    update jobs
       set status = 'scheduled',
           last_error = 'requeued_after_selector_fix',
           scheduled_for = now() + (random() * interval '60 minutes')
     where id = any(${ids}::uuid[])`.execute(db);

  console.log(`\nrequeued ${res.numAffectedRows ?? ids.length} job(s) over the next hour.`);
  console.log('The scheduler picks them up on its next tick (SCHEDULER_TICK_MS, default 30s).');
  process.exit(0);
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
