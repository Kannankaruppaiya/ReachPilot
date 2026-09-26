import { Injectable, NotFoundException } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';

@Injectable()
export class BillingService {
  async getPlans(): Promise<any[]> {
    const db = getDb();
    return db.selectFrom('plans').selectAll().execute();
  }

  async getSubscription(workspaceId: string): Promise<any> {
    const sub = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('subscriptions')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst(),
    );

    if (!sub) {
      // No subscription yet: provision one (currently 'pro').
      return this.createSubscription(workspaceId, 'pro');
    }

    return sub;
  }

  async createSubscription(workspaceId: string, planId: string): Promise<any> {
    const db = getDb();

    const plan = await db
      .selectFrom('plans')
      .selectAll()
      .where('id', '=', planId)
      .executeTakeFirst();

    if (!plan) {
      throw new NotFoundException('Plan not found.');
    }

    const now = new Date();
    const end = new Date();
    end.setMonth(end.getMonth() + 1);

    const sub = await withWorkspace(workspaceId, (wdb) =>
      wdb
        .insertInto('subscriptions')
        .values({
          workspace_id: workspaceId,
          plan_id: planId,
          status: 'active',
          current_period_start: now.toISOString(),
          current_period_end: end.toISOString(),
        })
        .onConflict((oc) =>
          oc.column('workspace_id').doUpdateSet({
            plan_id: planId,
            status: 'active',
            current_period_start: now.toISOString(),
            current_period_end: end.toISOString(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return sub;
  }
}
