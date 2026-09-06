/** Read-only: targets that produced repeated jobs, and any 404-ish failures. */
import { getDb } from '../src/db';
const { sql } = require('kysely');

(async () => {
  const db: any = getDb();
  const dup = await sql`
    select payload->>'target' target, count(*) n,
           count(*) filter (where status='sent') sent,
           count(*) filter (where status='failed') failed,
           count(*) filter (where status='scheduled') sched,
           array_agg(distinct last_error) errs,
           max(attempts) maxatt,
           to_char(max(created_at) at time zone 'Asia/Kolkata','MM-DD HH24:MI') last_created
    from jobs where kind='linkedin'
    group by 1 having count(*) > 1
    order by n desc limit 15`.execute(db);
  console.log('=== targets with >1 job ===');
  for (const r of dup.rows)
    console.log(
      `n=${r.n} sent=${r.sent} failed=${r.failed} sched=${r.sched} att=${r.maxatt} last=${r.last_created}\n   ${r.target}\n   errs=${JSON.stringify(r.errs)}`,
    );

  const err = await sql`
    select last_error, count(*) n, count(*) filter (where status='scheduled') still_sched, max(attempts) maxatt
    from jobs where kind='linkedin' and last_error is not null
    group by 1 order by n desc limit 25`.execute(db);
  console.log('\n=== last_error histogram ===');
  for (const r of err.rows)
    console.log(`${String(r.n).padStart(4)}  sched=${r.still_sched} att=${r.maxatt}  ${r.last_error}`);
  process.exit(0);
})();
