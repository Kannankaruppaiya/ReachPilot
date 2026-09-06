/** Read-only: how the darwin-ponraj (and any other recent) job was classified. */
import { getDb } from '../src/db';
const { sql } = require('kysely');

(async () => {
  const db: any = getDb();
  const r = await sql`
    select id, status, attempts, last_error, action,
           to_char(created_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') created,
           to_char(scheduled_for at time zone 'Asia/Kolkata','MM-DD HH24:MI') sched,
           to_char(sent_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') sent,
           payload->>'target' target
    from jobs
    where kind='linkedin'
      and (payload->>'target' ilike '%darwin%' or created_at > now() - interval '6 hours')
    order by created_at desc limit 15`.execute(db);
  console.log('=== darwin-ponraj / last 6h ===');
  for (const j of r.rows)
    console.log(
      `${j.created} sched=${j.sched} sent=${j.sent || '-'} ${String(j.status).padEnd(9)} att=${j.attempts} err=${j.last_error}\n   ${j.target}`,
    );

  const n = await sql`
    select to_char(created_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') t, kind, text
    from notifications where created_at > now() - interval '6 hours'
    order by created_at desc limit 10`.execute(db);
  console.log('\n=== notifications (6h) ===');
  for (const x of n.rows) console.log(`${x.t} [${x.kind}] ${x.text}`);
  process.exit(0);
})();
