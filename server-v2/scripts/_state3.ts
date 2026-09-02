/** Read-only: greatworks account + login state. */
import { getDb } from '../src/db';
const { sql } = require('kysely');

(async () => {
  const db: any = getDb();
  const a = await sql`select id, email, status, session_secret_id, totp_secret_id, password_secret_id,
      to_char(connected_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') conn,
      to_char(last_sync_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') sync
    from linkedin_accounts where email like '%greatworks%'`.execute(db);
  const x = a.rows[0];
  console.log('status             =', x.status);
  console.log('session_secret_id  =', x.session_secret_id ? String(x.session_secret_id).slice(0, 8) : 'null  <-- CLEARED by the forced re-login');
  console.log('totp_secret_id     =', x.totp_secret_id ? String(x.totp_secret_id).slice(0, 8) : 'null');
  console.log('connected_at       =', x.conn, '  last_sync_at =', x.sync);

  const n = await sql`select kind, left(text,90) text, to_char(created_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') t
    from notifications order by created_at desc limit 5`.execute(db);
  console.log('\nrecent notifications:');
  for (const r of n.rows) console.log('  ' + r.t + '  [' + r.kind + '] ' + String(r.text).replace(/\s+/g, ' '));

  const ac = await sql`select left(text,80) text, to_char(created_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') t
    from activity order by created_at desc limit 5`.execute(db);
  console.log('\nrecent activity:');
  for (const r of ac.rows) console.log('  ' + r.t + '  ' + String(r.text).replace(/\s+/g, ' '));

  console.log('\nnow IST:', new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' '));
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
