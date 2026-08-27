/** Temporary: undo the DB/Redis writes made by auto-connect dry-run verification. */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { getEnv } from '../src/config/env';
import Redis from 'ioredis';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const db = getDb();
  const wss = await db.selectFrom('workspaces').select(['id']).execute();
  const redis = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });

  for (const ws of wss) {
    const accts = (await withWorkspace(ws.id, (d: any) =>
      d.selectFrom('linkedin_accounts').select(['id', 'email', 'timezone']).where('email', '=', 'greatworksramesh@gmail.com').execute(),
    ).catch(() => [])) as any[];
    if (!accts.length) continue;

    // 1) remove the two fabricated activity rows
    const del: any = await withWorkspace(ws.id, (d: any) =>
      d.deleteFrom('activity').where('text', 'like', 'Connection request sent — https://www.linkedin.com/in/test-profile-demo%').executeTakeFirst(),
    ).catch((e: any) => { console.log('activity del err', e.message); return {}; });
    console.log(`ws ${ws.id.slice(0,8)}: deleted ${del?.numDeletedRows ?? 0} test activity row(s)`);

    for (const a of accts) {
      // 2) decrement today's daily_stats.invites_sent by the 2 I added
      const today = new Date().toLocaleDateString('en-US');
      await withWorkspace(ws.id, (d: any) =>
        d.updateTable('daily_stats')
          .set({ invites_sent: (eb: any) => eb('daily_stats.invites_sent', '-', 2) })
          .where('linkedin_account_id', '=', a.id).where('day', '=', today as any)
          .where('invites_sent', '>=', 2)
          .execute(),
      ).catch((e: any) => console.log('daily_stats err', e.message));

      // 3) roll back the Redis pacing counters + spacing stamp from the paced run
      const tz = a.timezone || 'UTC';
      const localDateIso = new Date().toLocaleDateString('en-US', { timeZone: tz });
      await redis.decr(`pacing:linkedin:${a.id}:date:${localDateIso}:daily`).catch(() => {});
      await redis.decr(`pacing:linkedin:${a.id}:weekly`).catch(() => {});
      await redis.del(`pacing:linkedin:${a.id}:nextallowed`).catch(() => {});
      console.log(`ws ${ws.id.slice(0,8)} acct ${a.id.slice(0,8)}: daily_stats -2, pacing daily/weekly -1, nextallowed cleared`);
    }
  }
  await redis.quit();
  await app.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
