import { getDb } from '../src/db';
const IP = process.argv[2] || '210.18.182.12';
const COUNTRY = process.argv[3] || 'IN';
(async () => {
  const db = getDb();
  const existing = await db.selectFrom('proxies').select('id').where('ip', '=', IP as any).executeTakeFirst();
  if (existing) { console.log('local proxy already exists:', existing.id); process.exit(0); }
  const row = await db.insertInto('proxies')
    .values({ provider: 'local', ip: IP as any, country: COUNTRY, healthy: true })
    .returning(['id', 'ip', 'country', 'provider'])
    .executeTakeFirstOrThrow();
  console.log('seeded:', JSON.stringify(row));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
