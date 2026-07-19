import { withWorkspace } from '../src/db/rls';
const WS='00000000-0000-0000-0000-000000000010';
(async()=>{ const a = await withWorkspace(WS, db=>db.selectFrom('linkedin_accounts').select(['id','status','hours_start','hours_end','send_weekends','timezone','warmup_daily_limit']).execute());
console.log('linkedin_accounts:', JSON.stringify(a)); console.log('now:', new Date().toString()); process.exit(0); })().catch(e=>{console.error(e);process.exit(1)});
