import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
(async()=>{ const db=getDb();
  const wss = await db.selectFrom('workspaces').select('id').execute();
  for (const w of wss) {
    const a = await withWorkspace(w.id,(d)=>d.selectFrom('linkedin_accounts').select(['email','status','twofa','session_secret_id','totp_secret_id']).execute());
    if (a.length) a.forEach((x:any)=>console.log(JSON.stringify({ws:w.id.slice(0,8), email:x.email, status:x.status, twofa:x.twofa, hasCookie:!!x.session_secret_id, hasTotp:!!x.totp_secret_id})));
  }
  process.exit(0);
})();
