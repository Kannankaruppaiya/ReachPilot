/** Prints the exact account-state payload the shell will render (real data). */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { LinkedinAccountsService } from '../src/modules/accounts/linkedin-accounts.service';
import { getDb } from '../src/db';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const svc = app.get(LinkedinAccountsService);
  const workspaces = await getDb().selectFrom('workspaces').select(['id', 'name']).execute();
  for (const ws of workspaces) {
    const state = await svc.getAccountState(ws.id);
    console.log(`\nWorkspace: ${ws.name}`);
    console.log(JSON.stringify(state, null, 2));
  }
  await app.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
