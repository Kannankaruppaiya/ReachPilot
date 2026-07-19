import { withWorkspace } from '../src/db/rls';
const WS='00000000-0000-0000-0000-000000000010';
const USER='00000000-0000-0000-0000-000000000001';
(async()=>{ await withWorkspace(WS, async db=>{
  const ex = await db.selectFrom('linkedin_accounts').select('id').where('workspace_id','=',WS).executeTakeFirst();
  if (ex) { console.log('already exists', ex.id); return; }
  const a = await db.insertInto('linkedin_accounts').values({
    workspace_id:WS, owner_user_id:USER, email:'test-li@example.com', country:'India',
    status:'warming_up', hours_start:'09:00', hours_end:'18:00', send_weekends:true,
    timezone:'Asia/Kolkata', warmup_daily_limit:18, warmup_target:45, weekly_invite_cap:100,
  } as any).returning('id').executeTakeFirstOrThrow();
  console.log('seeded linkedin_account', a.id);
}); process.exit(0); })().catch(e=>{console.error(e);process.exit(1)});
