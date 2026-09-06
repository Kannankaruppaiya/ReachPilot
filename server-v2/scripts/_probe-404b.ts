/** Read-only: the currently-scheduled backlog — how long each job has been bouncing. */
import { getDb } from '../src/db';
const { sql } = require('kysely');

(async () => {
  const db: any = getDb();
  const r = await sql`
    select id, status, action, attempts, last_error,
           to_char(created_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') created,
           to_char(scheduled_for at time zone 'Asia/Kolkata','MM-DD HH24:MI') sched,
           extract(epoch from (now() - created_at))/3600 age_h,
           payload->>'target' target
    from jobs
    where kind='linkedin' and status in ('scheduled','queued','running')
    order by created_at asc limit 25`.execute(db);
  console.log('=== open linkedin jobs (oldest first) ===');
  for (const j of r.rows)
    console.log(
      `${j.created} -> sched ${j.sched} age=${Number(j.age_h).toFixed(1)}h ${String(j.status).padEnd(9)} att=${j.attempts} err=${j.last_error}\n   ${j.target}`,
    );
  process.exit(0);
})();
