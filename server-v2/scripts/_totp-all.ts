/**
 * Every stored 2FA seed for the greatworks workspace with its current code, to
 * find which enrolment LinkedIn still accepts. --seed also prints the secrets
 * (clear the terminal afterwards).
 *
 *   npx ts-node -r tsconfig-paths/register scripts/_totp-all.ts [--seed]
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { authenticator } from 'otplib';
import { getDb } from '../src/db';
import { SecretsService } from '@/modules/vault/secrets.service';
const { sql } = require('kysely');

const WS = '2e27404a-9efe-4613-977a-1ab3fdece3d4';
const SHOW_SEED = process.argv.includes('--seed');

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const secrets = app.get(SecretsService);
  const db: any = getDb();

  const linked = await sql`select totp_secret_id from linkedin_accounts where email like '%greatworks%'`.execute(db);
  const linkedId = linked.rows[0]?.totp_secret_id || null;

  const rows = await sql`select id, to_char(created_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') cr
    from secrets where workspace_id=${WS} and kind='linkedin_totp' order by created_at`.execute(db);

  console.log(`${rows.rows.length} TOTP seed(s) stored for this workspace:\n`);
  for (const r of rows.rows) {
    const isLinked = r.id === linkedId;
    let code = '(could not decrypt)';
    let seed = '';
    try {
      seed = String(await secrets.decrypt(r.id, { workspaceId: WS })).replace(/\s+/g, '').toUpperCase();
      code = authenticator.generate(seed);
    } catch (e: any) {
      code = `(decrypt failed: ${e.message})`;
    }
    console.log(`  ${String(r.id).slice(0, 8)}  created ${r.cr}${isLinked ? '   <-- CURRENTLY LINKED' : ''}`);
    console.log(`     code now: ${code}`);
    if (SHOW_SEED && seed) console.log(`     seed    : ${seed}`);
    console.log('');
  }
  console.log(`(codes valid ${authenticator.timeRemaining()}s more)`);
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
