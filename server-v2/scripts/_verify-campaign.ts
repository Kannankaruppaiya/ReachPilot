/**
 * Throwaway end-to-end proof for the campaign sequence engine.
 * Mints a real JWT, creates + launches a campaign via the API, then reads the DB
 * to confirm steps compiled, leads enrolled, and the runner materialised a job.
 */
import 'dotenv/config';
import { Client } from 'pg';
import jwt from 'jsonwebtoken';

const API = 'http://localhost:4000';

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // Pick the workspace + owner + a couple of leads to work with.
  const ws = await db.query(
    `select w.id as ws, m.user_id as sub, u.email
       from workspaces w
       join memberships m on m.workspace_id = w.id
       join users u on u.id = m.user_id
      order by w.created_at asc limit 1`,
  );
  const { ws: workspaceId, sub, email } = ws.rows[0];
  const leads = await db.query(
    `select id, full_name from leads where workspace_id = $1 order by created_at desc limit 2`,
    [workspaceId],
  );
  const leadIds = leads.rows.map((r) => r.id);
  console.log('workspace', workspaceId, 'leads', leadIds.length, leads.rows.map((r) => r.full_name));

  const token = jwt.sign(
    { sub, email, workspaceId, role: 'owner' },
    process.env.JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1. Create + launch a campaign with a real sequence.
  const createRes = await fetch(`${API}/api/campaigns`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: `Engine test ${Date.now()}`,
      dailyCap: 10,
      leadIds,
      launch: true,
      steps: [
        { kind: 'view' },
        { kind: 'invite', body: 'Hi {{firstName}}, would love to connect re {{company}}.' },
        { kind: 'wait', days: 2 },
        { kind: 'branch', condition: 'if_connected', elseAction: { kind: 'email', subject: 'Following up', body: 'Hi {{firstName}}...' } },
        { kind: 'message', body: 'Thanks for connecting {{firstName}}!' },
      ],
    }),
  });
  const created = await createRes.json();
  console.log('CREATE', createRes.status, created.id, created.status);
  const id = created.id;

  // 2. Read it back — steps + enrollments.
  const detail = await (await fetch(`${API}/api/campaigns/${id}`, { headers: H })).json();
  console.log('STEPS', detail.steps?.length, detail.steps?.map((s: any) => `${s.kind}:${s.action || s.condition}@${s.delayHours}h`));
  console.log('ENROLLMENTS', detail.enrollments?.length, detail.enrollments?.map((e: any) => `${e.name}=${e.enrollmentStatus}`));

  // 3. Give the runner a moment (worker ticks ~every 60s; poke the DB directly to
  //    show what the engine produced without waiting a full minute).
  console.log('waiting 12s for the campaign runner…');
  await new Promise((r) => setTimeout(r, 12000));

  const jobs = await db.query(
    `select action, status, scheduled_for from jobs where campaign_id = $1 order by created_at`,
    [id],
  );
  console.log('JOBS created by runner:', jobs.rowCount);
  jobs.rows.forEach((j) => console.log('   ', j.action, j.status, j.scheduled_for));

  const enr = await db.query(
    `select status, current_step_id, next_run_at from enrollments where campaign_id = $1`,
    [id],
  );
  console.log('ENROLLMENT STATE:', enr.rows.map((r) => r.status));

  await db.end();
  console.log(jobs.rowCount && jobs.rowCount > 0 ? '\n✅ PASS — runner materialised outbound jobs.' : '\n⚠️  No jobs yet (runner may need another tick).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
