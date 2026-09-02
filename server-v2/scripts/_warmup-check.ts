/** Read-only: what the warm-up ramp thinks, and what it SHOULD think. */
import { getDb } from '../src/db';
import { computeWarmup } from '@/modules/engine/warmup';
const { sql } = require('kysely');

(async () => {
  const db: any = getDb();
  const r = await sql`select email, status, warmup_daily_limit, warmup_target,
      connected_at, created_at,
      to_char(connected_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') conn,
      to_char(created_at   at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') cre,
      (select count(*)::int from jobs j where j.linkedin_account_id = linkedin_accounts.id and j.status='sent') sent
    from linkedin_accounts order by created_at`.execute(db);
  for (const x of r.rows) {
    const now = computeWarmup(x.connected_at, x.warmup_daily_limit, x.warmup_target);
    const should = computeWarmup(x.created_at, x.warmup_daily_limit, x.warmup_target);
    console.log(`${x.email}`);
    console.log(`  connected_at=${x.conn}   created_at=${x.cre}   sent=${x.sent}`);
    console.log(`  ramp FROM connected_at : ${now.todayLimit}/${now.target}  (${now.daysToFull}d to full)`);
    console.log(`  ramp FROM created_at   : ${should.todayLimit}/${should.target}  (${should.daysToFull}d to full)`);
    console.log('');
  }
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
