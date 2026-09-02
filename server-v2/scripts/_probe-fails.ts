/** Read-only: history for the two failed targets. */
import { getDb } from '../src/db';
const { sql } = require('kysely');
const T = ['ACwAAAiiOrsBhXXaTRErq1E9Zy2pDoo8Y6LW5z0','ACwAAADPH9QBxP1gXs6E8qL30ERVvzPduGe3F7g'];

(async () => {
  const db: any = getDb();
  for (const t of T) {
    console.log(`\n===== ${t} =====`);
    const j = await sql`select id, status, attempts, last_error, payload->>'target' target,
        payload->>'resolvedSlug' rslug,
        to_char(created_at at time zone 'Asia/Kolkata','MM-DD HH24:MI') created
      from jobs where payload->>'target' like ${'%' + t + '%'} order by created_at desc`.execute(db);
    console.log(`  jobs: ${j.rows.length}`);
    for (const r of j.rows) console.log(`    ${r.created} ${r.status} err=${r.last_error || '-'} rslug=${r.rslug || '-'}`);
    const l = await sql`select id, status, full_name, linkedin_url, last_activity
      from leads where linkedin_url like ${'%' + t + '%'}`.execute(db);
    console.log(`  leads: ${l.rows.length}`);
    for (const r of l.rows) console.log(`    status=${r.status} name=${r.full_name} act=${r.last_activity || '-'} url=${r.linkedin_url}`);
  }
  process.exit(0);
})();
