/** Temporary: cancel stale duplicate pending connect_request jobs, keeping one per target. */
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';

const KEEP = ['274b5061', '12030f8d']; // Sanjay Koushik, Darshana Karnik (the UI batch)

(async () => {
  const db = getDb();
  const wss = await db.selectFrom('workspaces').select(['id']).execute();

  for (const ws of wss) {
    const jobs = (await withWorkspace(ws.id, (d: any) =>
      d
        .selectFrom('jobs')
        .select(['id', 'action', 'status', 'payload'])
        .where('action', '=', 'connect_request')
        .where('status', 'in', ['scheduled', 'queued', 'running'])
        .execute(),
    ).catch(() => [])) as any[];

    for (const j of jobs) {
      const p: any = typeof j.payload === 'string' ? (() => { try { return JSON.parse(j.payload); } catch { return {}; } })() : j.payload || {};
      const keep = KEEP.some((k) => j.id.startsWith(k));
      if (keep) {
        console.log(`KEEP   ${j.id.slice(0, 8)}  ${p.name}`);
        continue;
      }
      await withWorkspace(ws.id, (d: any) =>
        d
          .updateTable('jobs')
          .set({ status: 'canceled', last_error: 'duplicate_invite_manual_dedupe' })
          .where('id', '=', j.id)
          .execute(),
      );
      console.log(`CANCEL ${j.id.slice(0, 8)}  ${p.name}  (duplicate)`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
