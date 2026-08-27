require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ws='2e27404a-9efe-4613-977a-1ab3fdece3d4';
  const acct='508cd4a6-8b18-4863-a936-80a0c35ea3d6';
  const now = new Date();
  console.log('=== MONITOR', now.toISOString(), '===');
  // today's sends
  const ds = await c.query(`SELECT day,invites_sent,warmup_daily_limit FROM daily_stats ds JOIN linkedin_accounts la ON la.id=ds.linkedin_account_id WHERE ds.linkedin_account_id=$1 ORDER BY day DESC LIMIT 2`, [acct]);
  console.log('daily_stats:', JSON.stringify(ds.rows));
  // connect job status breakdown
  const d = await c.query(`SELECT status,coalesce(last_error,'-') le,count(*) FROM jobs WHERE workspace_id=$1 AND action='connect_request' GROUP BY status,last_error ORDER BY 3 DESC`, [ws]);
  console.log('connect breakdown:'); d.rows.forEach(r=>console.log(`  ${r.status.padEnd(10)} | ${r.le.padEnd(22)} | ${r.count}`));
  // next scheduled connect jobs
  const nx = await c.query(`SELECT payload->>'name' n, scheduled_for, coalesce(last_error,'-') le FROM jobs WHERE workspace_id=$1 AND action='connect_request' AND status IN ('scheduled','queued','running') ORDER BY scheduled_for ASC LIMIT 6`, [ws]);
  console.log('upcoming:'); nx.rows.forEach(r=>console.log(`  ${(r.n||'').padEnd(22)} ${r.scheduled_for?.toISOString?.()} le=${r.le}`));
  // most recent sent
  const s = await c.query(`SELECT payload->>'name' n, sent_at, coalesce(last_error,'-') le FROM jobs WHERE workspace_id=$1 AND action='connect_request' AND status='sent' ORDER BY sent_at DESC NULLS LAST LIMIT 3`, [ws]);
  console.log('recent sent:'); s.rows.forEach(r=>console.log(`  ${(r.n||'').padEnd(22)} ${r.sent_at?.toISOString?.()||'-'} le=${r.le}`));
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1);});
