/** Read-only: the most recent jobs across all workspaces, newest first. */
import { getDb } from '../src/db';
const { sql } = require('kysely');

(async () => {
  const db: any = getDb();
  const r = await sql`
    select id, status, action, attempts, last_error,
           to_char(created_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') created,
           to_char(scheduled_for at time zone 'Asia/Kolkata','MM-DD HH24:MI') sched,
           to_char(sent_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') sent,
           payload->>'target' target, payload->>'noNote' nonote, payload->>'useAi' useai,
           linkedin_account_id acct
    from jobs
    where kind = 'linkedin'
    order by created_at desc, scheduled_for desc
    limit 20`.execute(db);
  for (const j of r.rows) {
    console.log(`${j.created}  ${String(j.status).padEnd(9)} att=${j.attempts} sched=${j.sched} sent=${j.sent || '-'}`);
    console.log(`   err=${j.last_error || '-'}   noNote=${j.nonote} useAi=${j.useai}`);
    console.log(`   ${j.target}`);
  }
  process.exit(0);
})();
