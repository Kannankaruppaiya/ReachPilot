require('dotenv').config();
const { Client } = require('pg');
const ws='2e27404a-9efe-4613-977a-1ab3fdece3d4';
async function sample(c){
  const sent = await c.query(`SELECT count(*) n FROM jobs WHERE workspace_id=$1 AND action='connect_request' AND status='sent'`,[ws]);
  const badSched = await c.query(`SELECT count(*) n FROM jobs WHERE workspace_id=$1 AND action='connect_request' AND status='scheduled' AND last_error IN ('agent_unavailable','agent_result_pending')`,[ws]);
  const pend = await c.query(`SELECT count(*) n FROM jobs WHERE workspace_id=$1 AND action='connect_request' AND status='sent' AND last_error='agent_result_pending'`,[ws]);
  const lastSent = await c.query(`SELECT payload->>'name' n, sent_at, coalesce(last_error,'-') le FROM jobs WHERE workspace_id=$1 AND action='connect_request' AND status='sent' ORDER BY sent_at DESC NULLS LAST LIMIT 1`,[ws]);
  const ls=lastSent.rows[0]||{};
  return {sent:+sent.rows[0].n, badSched:+badSched.rows[0].n, pend:+pend.rows[0].n, last:`${ls.n||''}@${ls.sent_at?.toISOString?.()||'-'} le=${ls.le||'-'}`};
}
(async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
  await c.connect();
  let base=null;
  for(let i=0;i<12;i++){ // 12 * 90s = 18 min
    const s=await sample(c);
    if(!base) base=s.sent;
    const t=new Date().toISOString().slice(11,19);
    const delta=s.sent-base;
    console.log(`[${t}] sent=${s.sent}(+${delta}) newBadScheduled=${s.badSched} sentButPending=${s.pend} last="${s.last}"`);
    if(i<11) await new Promise(r=>setTimeout(r,90000));
  }
  await c.end();
  console.log('WATCH DONE');
})().catch(e=>{console.error('watch err',e.message);process.exit(1);});
