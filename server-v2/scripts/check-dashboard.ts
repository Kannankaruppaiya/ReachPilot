/** Prints the real dashboard payload the UI will render (proves no dummy data). */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { getDb } from '../src/db';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const svc = app.get(DashboardService);
  const workspaces = await getDb().selectFrom('workspaces').select(['id', 'name']).execute();
  for (const w of workspaces) {
    const d = await svc.getDashboardData(w.id);
    console.log(`\nWorkspace: ${w.name}`);
    console.log(
      JSON.stringify(
        {
          invitesSent: d.invitesSent,
          acceptanceRate: d.acceptanceRate,
          replies: d.replies,
          meetings: d.meetings,
          totalLeads: d.totalLeads,
          queuedToday: d.queuedToday,
          scheduled: d.scheduled,
          sentToday: d.sentToday,
          account: d.account,
          activityCount: d.activity.length,
        },
        null,
        2,
      ),
    );
  }
  await app.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
