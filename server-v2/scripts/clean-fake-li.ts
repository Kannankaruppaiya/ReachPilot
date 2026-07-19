import { withWorkspace } from '../src/db/rls';
const WS='00000000-0000-0000-0000-000000000010';
(async()=>{ await withWorkspace(WS, async db=>{
  const accts = await db.selectFrom('linkedin_accounts').select(['id','email']).where('workspace_id','=',WS).execute();
  for (const a of accts.filter(x=>x.email==='test-li@example.com')) {
    await db.deleteFrom('daily_stats').where('linkedin_account_id','=',a.id).execute();
    await db.deleteFrom('linkedin_accounts').where('id','=',a.id).execute();
    console.log('deleted fake account', a.id);
  }
  const left = await db.selectFrom('linkedin_accounts').select('email').where('workspace_id','=',WS).execute();
  console.log('remaining accounts:', JSON.stringify(left));
}); process.exit(0); })().catch(e=>{console.error(e);process.exit(1)});
