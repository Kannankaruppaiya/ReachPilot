import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { LinkedInSessionService } from '../src/modules/drivers/linkedin-session.service';
import { LINKEDIN_DRIVER } from '../src/modules/drivers/driver.tokens';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule);
  const sessions = app.get(LinkedInSessionService);
  const driver: any = app.get(LINKEDIN_DRIVER);
  const db = getDb();

  // Find the account that has a stored TOTP (went through 2FA).
  const wss = await db.selectFrom('workspaces').select('id').execute();
  let target: { id: string; ws: string } | null = null;
  for (const w of wss) {
    const rows = await withWorkspace(w.id, (d) =>
      d
        .selectFrom('linkedin_accounts')
        .select(['id', 'email', 'status', 'totp_secret_id', 'password_secret_id'])
        .execute(),
    );
    for (const r of rows as any[]) {
      console.log(
        `acct ${r.id.slice(0, 8)} ws ${w.id.slice(0, 8)} ${r.email} status=${r.status} totp=${!!r.totp_secret_id} pw=${!!r.password_secret_id}`,
      );
      if (r.totp_secret_id && r.password_secret_id) target = { id: r.id, ws: w.id };
    }
  }

  if (!target) {
    console.log('No account with password + TOTP found.');
    process.exit(0);
  }

  console.log('\n--- Running login for', target.id.slice(0, 8), '---');
  const ctx = await sessions.buildLoginContext(target.id, target.ws);
  console.log('ctx:', {
    email: ctx?.email,
    hasPw: !!ctx?.password,
    hasTotp: !!ctx?.totpSecret,
    proxy: ctx?.proxy || 'DIRECT (local IP)',
  });
  const res = await driver.login(ctx);
  console.log('\n=== LOGIN RESULT ===');
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error('DIAG ERROR:', e);
  process.exit(1);
});
