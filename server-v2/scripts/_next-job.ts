import { getDb } from '../src/db';
(async () => {
  const db: any = getDb();
  const now = new Date();
  console.log('now UTC =', now.toISOString(), '| IST =', new Date(now.getTime()+5.5*3600e3).toISOString().replace('T',' ').slice(0,19));
  const a = await db.selectFrom('linkedin_accounts').selectAll().where('email','like','%greatworks%').execute();
  for (const x of a) console.log(`acct ${x.id} ws=${x.workspace_id} ${x.email} status=${x.status} tz=${x.timezone} hrs=${x.hours_start}-${x.hours_end} cap=${x.warmup_daily_limit}/${x.warmup_target} weekly=${x.weekly_invite_cap} lastSync=${x.last_sync_at}`);
  const id = a[0].id;
  const last = await db.selectFrom('jobs').select(['id','action','status','scheduled_for','sent_at','last_error'])
    .where('linkedin_account_id','=',id).where('sent_at','is not',null).orderBy('sent_at','desc').limit(5).execute();
  console.log('\n-- last sent --');
  for (const j of last) console.log(`  ${new Date(j.sent_at).toISOString()}  ${j.action} ${j.status}`);
  const next = await db.selectFrom('jobs').select(['id','action','status','scheduled_for','attempts','last_error'])
    .where('linkedin_account_id','=',id).where('status','in',['scheduled','queued']).orderBy('scheduled_for','asc').limit(5).execute();
  console.log('\n-- next scheduled --');
  for (const j of next) {
    const t=new Date(j.scheduled_for); const m=Math.round((t.getTime()-now.getTime())/60000);
    console.log(`  ${t.toISOString()} UTC = ${new Date(t.getTime()+5.5*3600e3).toISOString().replace('T',' ').slice(0,16)} IST  ${m<0?`${-m}m overdue`:`in ${m}m`}  ${j.action} ${j.status}`);
  }
  // per-day distribution of remaining
  const rows = await db.selectFrom('jobs').select(['scheduled_for']).where('linkedin_account_id','=',id).where('status','in',['scheduled','queued']).orderBy('scheduled_for','asc').execute();
  const byDay: Record<string,number> = {};
  for (const r of rows) { const d = new Date(new Date(r.scheduled_for).getTime()+5.5*3600e3).toISOString().slice(0,10); byDay[d]=(byDay[d]||0)+1; }
  console.log('\n-- remaining per IST day --');
  for (const [d,n] of Object.entries(byDay)) console.log(`  ${d}: ${n}`);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
