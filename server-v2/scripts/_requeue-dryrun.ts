/** Read-only: exactly what the "Retry failed" button would do. Writes nothing. */
import { getDb } from '../src/db';
import { isRequeueableFailure } from '../src/modules/drivers/linkedin-driver.interface';
const { sql } = require('kysely');
const WS = '31acca15-1c4b-4869-a893-a702e53b50a0';
(async () => {
  const db: any = getDb();
  const r = await sql`select id, payload->>'name' name, last_error,
      to_char(scheduled_for at time zone 'Asia/Kolkata','MM-DD HH24:MI') t
    from jobs where workspace_id=${WS} and kind='linkedin' and status='failed'
    order by scheduled_for`.execute(db);
  let yes = 0, no = 0;
  console.log('WOULD REQUEUE:');
  for (const x of r.rows) if (isRequeueableFailure(x.last_error)) { yes++; console.log(`  ${x.t}  ${String(x.last_error).split('\n')[0].slice(0,48)}`); }
  console.log('\nLEFT ALONE:');
  for (const x of r.rows) if (!isRequeueableFailure(x.last_error)) { no++; console.log(`  ${x.t}  ${String(x.last_error).split('\n')[0].slice(0,48)}`); }
  console.log(`\n=> requeued=${yes}  skipped=${no}  total=${r.rows.length}`);
  process.exit(0);
})();
