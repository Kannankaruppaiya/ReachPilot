/**
 * Read-only: which of the three gates that all return "tomorrow's opening hour"
 * actually fired — the daily cap (a REDIS counter, not the DB sent count), the
 * per-campaign cap, or the weekly invite cap.
 */
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
const { sql } = require('kysely');

(async () => {
  const db: any = getDb();
  let acct: any = null;
  for (const w of (await db.selectFrom('workspaces').select('id').execute()) as any[]) {
    const rows = (await withWorkspace(w.id, (d: any) =>
      d.selectFrom('linkedin_accounts').selectAll().execute(),
    ).catch(() => [])) as any[];
    const f = rows.find((r) => String(r.email).includes('greatworks'));
    if (f) { acct = f; break; }
  }
  const tz = acct.timezone || 'UTC';
  console.log(`weekly_invite_cap : ${acct.weekly_invite_cap}`);

  const week = Number((await sql`
    select count(*)::int n from jobs
     where kind='linkedin' and action='connect_request' and status='sent'
       and sent_at >= now() - interval '7 days'`.execute(db)).rows[0].n);
  console.log(`invites last 7d   : ${week}`);
  console.log(`   -> weekly gate : ${week >= acct.weekly_invite_cap ? 'WOULD BLOCK' : `${acct.weekly_invite_cap - week} left`}`);

  // The daily REDIS counter is incremented on every ATTEMPT and only rolled back
  // when release() runs. Terminal failures and defers that did not release leave
  // it above the number actually sent — which is what the daily gate compares.
  const today = await sql`
    select status, coalesce(last_error,'-') err, count(*)::int n
      from jobs
     where kind='linkedin' and action='connect_request'
       and scheduled_for >= date_trunc('day', now() at time zone ${tz})
     group by 1,2 order by 3 desc`.execute(db);
  console.log(`\ntoday's connect jobs by outcome (each one registered a slot):`);
  let attempts = 0;
  for (const r of today.rows as any[]) {
    console.log(`   ${String(r.status).padEnd(10)} ${String(r.err).slice(0, 26).padEnd(26)} ${r.n}`);
    attempts += r.n;
  }
  console.log(`   total rows scheduled for today: ${attempts}`);
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
