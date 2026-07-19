/** Temporary: dump jobs/leads/queue state for the in-progress send test. */
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { getEnv } from '../src/config/env';
import Redis from 'ioredis';

(async () => {
  const db = getDb();
  const wss = await db.selectFrom('workspaces').select(['id', 'name']).execute();

  for (const ws of wss) {
    const jobs = (await withWorkspace(ws.id, (d: any) =>
      d
        .selectFrom('jobs')
        .select(['id', 'kind', 'action', 'status', 'scheduled_for', 'sent_at', 'last_error', 'payload'])
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute(),
    ).catch(() => [])) as any[];

    const leads = (await withWorkspace(ws.id, (d: any) =>
      d
        .selectFrom('leads')
        .select(['full_name', 'status', 'linkedin_url', 'last_activity'])
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute(),
    ).catch(() => [])) as any[];

    if (!jobs.length && !leads.length) continue;
    console.log(`\n=== workspace ${ws.id.slice(0, 8)} (${ws.name}) ===`);
    console.log('-- jobs --');
    for (const j of jobs) {
      const p: any = typeof j.payload === 'string' ? (() => { try { return JSON.parse(j.payload); } catch { return {}; } })() : j.payload || {};
      const pending = ['queued', 'scheduled', 'running'].includes(j.status);
      console.log(`  ${pending ? '>>' : '  '} ${j.id.slice(0, 8)} ${j.action} status=${j.status} err=${j.last_error || '-'}`);
      console.log(`       name=${p.name || '(none)'}  target=${p.target || '(none)'}`);
    }
    console.log('-- leads --');
    for (const l of leads) console.log(`  ${l.full_name}  status=${l.status}  act=${l.last_activity || '-'}`);
  }

  // BullMQ queue depth — proves whether anything is consuming the queue.
  const redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  for (const q of ['linkedin-actions', 'email-send', 'linkedin-login']) {
    const waiting = await redis.llen(`bull:${q}:wait`).catch(() => -1);
    const active = await redis.llen(`bull:${q}:active`).catch(() => -1);
    const delayed = await redis.zcard(`bull:${q}:delayed`).catch(() => -1);
    console.log(`\nqueue ${q}: waiting=${waiting} active=${active} delayed=${delayed}`);
  }
  await redis.quit();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
