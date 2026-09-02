/** Temp: dump the most recent jobs + BullMQ failed-job stack traces. Read-only. */
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { getEnv } from '../src/config/env';
import Redis from 'ioredis';

(async () => {
  const db = getDb();
  const wss = await db.selectFrom('workspaces').select(['id', 'name']).execute();

  for (const ws of wss) {
    const jobs = (await withWorkspace(ws.id, (d: any) =>
      d.selectFrom('jobs')
        .select(['id','kind','action','status','scheduled_for','sent_at','attempts','last_error','payload','created_at','linkedin_account_id','lead_id'])
        .orderBy('created_at','desc').limit(15).execute(),
    ).catch(() => [])) as any[];
    if (!jobs.length) continue;
    console.log(`\n=== workspace ${ws.id.slice(0,8)} (${ws.name}) ===`);
    for (const j of jobs) {
      const p: any = typeof j.payload === 'string' ? (()=>{try{return JSON.parse(j.payload)}catch{return{}}})() : j.payload || {};
      console.log(`  ${j.id.slice(0,8)} ${String(j.action).padEnd(16)} status=${String(j.status).padEnd(10)} att=${j.attempts}`);
      console.log(`     created=${j.created_at?.toISOString?.() ?? j.created_at}  sched=${j.scheduled_for?.toISOString?.() ?? j.scheduled_for}  sent=${j.sent_at?.toISOString?.() ?? '-'}`);
      console.log(`     err=${j.last_error || '-'}`);
      console.log(`     target=${p.target || p.profileUrl || '(none)'}  acct=${j.linkedin_account_id?.slice(0,8) || '-'}`);
    }
    const accts = (await withWorkspace(ws.id, (d:any)=>
      d.selectFrom('linkedin_accounts').select(['id','status','warmup_daily_limit','warmup_target','hours_start','hours_end','timezone','send_weekends']).execute()
    ).catch((e:any)=>{console.log('  acct read err', e.message); return []})) as any[];
    for (const a of accts) console.log(`  acct ${a.id.slice(0,8)} status=${a.status} warm=${a.warmup_daily_limit}/${a.warmup_target} hrs=${a.hours_start}-${a.hours_end} tz=${a.timezone} wknd=${a.send_weekends}`);
  }

  const redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  for (const q of ['linkedin-actions','linkedin-login','email-send']) {
    const waiting = await redis.llen(`bull:${q}:wait`).catch(()=>-1);
    const active  = await redis.llen(`bull:${q}:active`).catch(()=>-1);
    const delayed = await redis.zcard(`bull:${q}:delayed`).catch(()=>-1);
    const failedIds = await redis.zrange(`bull:${q}:failed`, -5, -1).catch(()=>[] as string[]);
    console.log(`\nqueue ${q}: wait=${waiting} active=${active} delayed=${delayed} failed=${failedIds.length}`);
    for (const id of failedIds) {
      const h = await redis.hgetall(`bull:${q}:${id}`);
      console.log(`  --- failed job ${id} (name=${h.name}) attempts=${h.attemptsMade} ---`);
      console.log(`      data: ${(h.data||'').slice(0,300)}`);
      console.log(`      reason: ${h.failedReason}`);
      if (h.stacktrace) { try { console.log(`      stack: ${JSON.parse(h.stacktrace).join('\n             ').slice(0,2000)}`); } catch { console.log(`      stack: ${h.stacktrace.slice(0,1500)}`); } }
    }
  }
  const keys = await redis.keys('pacing*').catch(()=>[] as string[]);
  const lk = await redis.keys('*nextallowed*').catch(()=>[] as string[]);
  const ck = await redis.keys('login:cooldown:*').catch(()=>[] as string[]);
  console.log('');
  for (const k of [...keys, ...lk, ...ck].slice(0,40)) {
    const t = await redis.type(k);
    const v = t === 'string' ? await redis.get(k) : t;
    const ttl = await redis.ttl(k);
    console.log(`  redis ${k} = ${v} (ttl=${ttl})`);
  }
  await redis.quit();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
