const { Client } = require('pg');
(async () => {
  const c = new Client('postgresql://reachpilot:reachpilot@localhost:5432/reachpilot');
  await c.connect();
  
  await c.query('BEGIN');
  // Count leads in the dev workspace (RLS needs a workspace context).
  await c.query("SELECT set_config('app.workspace_id', '00000000-0000-0000-0000-000000000010', true)");
  const r = await c.query('SELECT count(*) as cnt FROM leads');
  console.log('Dev workspace leads:', r.rows[0].cnt);
  await c.query('COMMIT');
  
  await c.end();
})();
