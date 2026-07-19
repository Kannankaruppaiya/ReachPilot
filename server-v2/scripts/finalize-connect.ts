import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { SecretsService } from '../src/modules/vault/secrets.service';
import { LinkedInSessionService } from '../src/modules/drivers/linkedin-session.service';
import { LINKEDIN_DRIVER } from '../src/modules/drivers/driver.tokens';

const EMAIL = 'greatworksramesh@gmail.com';
const CORRECT_PW = 'Crazyhorse@123';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule);
  const secrets = app.get(SecretsService);
  const sessions = app.get(LinkedInSessionService);
  const driver: any = app.get(LINKEDIN_DRIVER);
  const db = getDb();

  const wss = await db.selectFrom('workspaces').select('id').execute();
  // Fix the stored password on every matching account so future logins work.
  const accounts: { id: string; ws: string; hasTotp: boolean }[] = [];
  for (const w of wss) {
    const rows = await withWorkspace(w.id, (d) =>
      d.selectFrom('linkedin_accounts').select(['id', 'email', 'totp_secret_id']).where('email', '=', EMAIL).execute(),
    );
    for (const r of rows as any[]) {
      const sid = await secrets.encrypt(CORRECT_PW, 'linkedin_password', { workspaceId: w.id });
      await withWorkspace(w.id, (d) =>
        d.updateTable('linkedin_accounts').set({ password_secret_id: sid }).where('id', '=', r.id).execute(),
      );
      accounts.push({ id: r.id, ws: w.id, hasTotp: !!r.totp_secret_id });
      console.log(`fixed password for acct ${r.id.slice(0, 8)} (ws ${w.id.slice(0, 8)}) totp=${!!r.totp_secret_id}`);
    }
  }

  // Connect the 2FA-enabled account: real login → store the session cookie.
  const target = accounts.find((a) => a.hasTotp) || accounts[0];
  if (!target) { console.log('no account'); process.exit(0); }
  console.log('\nLogging in acct', target.id.slice(0, 8), '...');
  const ctx = await sessions.buildLoginContext(target.id, target.ws);
  const res = await driver.login(ctx);
  console.log('login:', res.status, res.error || '');

  if (res.status === 'connected' && res.li_at) {
    const secId = await secrets.encrypt(res.li_at, 'linkedin_session', { workspaceId: target.ws });
    await withWorkspace(target.ws, (d) =>
      d
        .updateTable('linkedin_accounts')
        .set({ session_secret_id: secId, status: 'warming_up', last_sync_at: new Date().toISOString() })
        .where('id', '=', target.id)
        .execute(),
    );
    console.log('\n✅ CONNECTED — cookie stored, status = warming_up (ws', target.ws.slice(0, 8) + ')');
  } else {
    console.log('\n❌ login did not connect:', res.status, res.error);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
