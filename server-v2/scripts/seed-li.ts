import { withWorkspace } from '../src/db/rls';
const WS='00000000-0000-0000-0000-000000000010';
(async()=>{ await withWorkspace(WS, async db=>{
  await db.insertInto('leads').values({workspace_id:WS,full_name:'Arjun Mehta',first_name:'Arjun',title:'VP Sales',company:'Northwind',email:'arjun@northwind.io',location:'Mumbai',linkedin_url:'https://linkedin.com/in/arjun-mehta-test',status:'new',tags:['SaaS']} as any).execute();
  console.log('seeded lead');
}); process.exit(0); })().catch(e=>{console.error(e);process.exit(1)});
