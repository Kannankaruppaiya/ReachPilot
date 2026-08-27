/**
 * Re-drive connect jobs that were failed by the broken top-card detection.
 *
 * `no_connect_button` is TERMINAL, so a lead hit by any of these defects was
 * burned permanently even when nothing was wrong with it:
 *   - the overflow trigger was never found (page tier asked for "More actions",
 *     the real button says "More"), so the menu holding Connect never opened;
 *   - an OUTSTANDING invite was invisible: Pending is an <a>, not a <button>, so
 *     a lead whose invitation had genuinely been delivered read as `failed`.
 *
 * Resetting them to `scheduled` lets the fixed driver decide again:
 *   invite already out -> `pending`  -> SKIP  -> marked sent (shows as Awaiting)
 *   connectable        -> the invite actually goes out this time
 *   truly unreachable  -> fails again, with an accurate reason
 *
 * ⚠️ Re-driving a lead whose invite never went out SENDS A REAL INVITE and spends
 * daily pacing. Dry-run by default; pass --apply to write.
 * ⚠️ Restart the desktop app FIRST — the agent runs a bundled copy of the driver,
 * so without a rebuild+restart these jobs re-run on the OLD code and fail again.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/requeue-misfailed.ts [--apply]
 */
import { getDb } from '../src/db';
const { sql } = require('kysely');

const APPLY = process.argv.includes('--apply');
/**
 * Restrict to specific job ids. Use this — do not requeue the whole set blind.
 * Only a lead LinkedIn ALREADY shows as "Pending" is free to re-drive: the fixed
 * driver reads Pending, returns the `pending` outcome, and the row is corrected
 * without sending anything. For a lead with no outstanding invite, re-driving
 * SENDS A REAL INVITE — a decision for the operator, not this script.
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

  // Spread them over the next hour rather than dumping the whole set at once;
  // pacing still caps them at send time, this only avoids a thundering herd.
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
