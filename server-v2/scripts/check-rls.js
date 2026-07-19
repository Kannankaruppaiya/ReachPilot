const { Client } = require('pg');
(async () => {
  const c = new Client('postgresql://reachpilot:reachpilot@localhost:5432/reachpilot');
  await c.connect();
  
  // Need to set workspace context first since RLS is now enforced
  await c.query('BEGIN');
  // Use a permissive query via the postgres user — but we can't. 
  // Let's just check all workspaces and what leads exist per workspace_id
  // Since we need to look across all workspaces, use a hack: 
  // set workspace_id to a wildcard — not possible. 
  // Instead set it to one workspace and see.
  await c.query("SELECT set_config('app.workspace_id', '00000000-0000-0000-0000-000000000010', true)");
  const r = await c.query('SELECT count(*) as cnt FROM leads');
  console.log('Dev workspace leads:', r.rows[0].cnt);
  await c.query('COMMIT');
  
  await c.end();
})();
