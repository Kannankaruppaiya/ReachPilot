/**
 * Print the account's current 2FA code from the stored seed. --seed also prints
 * the secret (only for re-adding to an authenticator; clear the terminal after).
 *
 *   npx ts-node -r tsconfig-paths/register scripts/_totp-code.ts [email-substring] [--seed]
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { authenticator } from 'otplib';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { SecretsService } from '@/modules/vault/secrets.service';

const MATCH = (process.argv[2] || 'greatworks').replace(/^--.*/, '') || 'greatworks';
const SHOW_SEED = process.argv.includes('--seed');

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const secrets = app.get(SecretsService);
  const db = getDb();

  let acct: any;
  let wsId = '';
  for (const ws of await db.selectFrom('workspaces').select(['id']).execute()) {
    const rows = (await withWorkspace(ws.id, (d: any) =>
      d.selectFrom('linkedin_accounts').select(['id', 'email', 'totp_secret_id']).execute(),
    ).catch(() => [])) as any[];
    const f = rows.find((r) => String(r.email).includes(MATCH));
    if (f) {
      acct = f;
      wsId = ws.id;
      break;
    }
  }
  if (!acct) {
    console.log(`no account matching "${MATCH}"`);
    process.exit(1);
  }
  if (!acct.totp_secret_id) {
    console.log(`${acct.email}: no 2FA seed stored`);
    process.exit(1);
  }

  const seed = await secrets.decrypt(acct.totp_secret_id, { workspaceId: wsId });
  const clean = String(seed).replace(/\s+/g, '').toUpperCase();

  console.log(`account : ${acct.email}`);
  console.log(`seed    : stored OK (secret ${String(acct.totp_secret_id).slice(0, 8)}, ${clean.length} chars)`);
  console.log('');
  console.log(`  >>> CODE:  ${authenticator.generate(clean)}    (valid ${authenticator.timeRemaining()}s more)`);
  if (SHOW_SEED) {
    console.log('');
    console.log(`  >>> SEED:  ${clean}`);
    console.log('      Add this to your authenticator app, then clear this terminal.');
  }
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
