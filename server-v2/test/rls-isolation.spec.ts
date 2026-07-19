import { withWorkspace } from '@/db/rls';
import { getDb } from '@/db';
import * as crypto from 'crypto';

describe('Row Level Security (RLS) Tenant Isolation', () => {
  const wsA = '00000000-0000-0000-0000-00000000001a';
  const wsB = '00000000-0000-0000-0000-00000000001b';

  beforeAll(async () => {
    // Workspaces table has no RLS — insert directly
    const db = getDb();
    await db
      .insertInto('workspaces')
      .values({
        id: wsA,
        name: 'Workspace A',
        goal: 'Testing',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('workspaces')
      .values({
        id: wsB,
        name: 'Workspace B',
        goal: 'Testing',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  });

  it('should prevent Workspace B from reading Workspace A leads', async () => {
    const leadId = crypto.randomUUID();

    // Insert lead under Workspace A (must set RLS context)
    await withWorkspace(wsA, async (trx) => {
      await trx
        .insertInto('leads')
        .values({
          id: leadId,
          workspace_id: wsA,
          full_name: 'Tenant Lead A',
          first_name: 'Tenant',
          title: 'CTO',
          company: 'Comp A',
          location: 'US',
          status: 'new',
          source: 'Test',
          last_activity: 'Created',
        })
        .execute();
    });

    // Read under Workspace A scope → should find the lead
    const leadA = await withWorkspace(wsA, async (trx) => {
      return trx
        .selectFrom('leads')
        .selectAll()
        .where('id', '=', leadId)
        .executeTakeFirst();
    });

    expect(leadA).toBeDefined();
    expect(leadA?.full_name).toBe('Tenant Lead A');

    // Read under Workspace B scope → must NOT see the lead
    const leadB = await withWorkspace(wsB, async (trx) => {
      return trx
        .selectFrom('leads')
        .selectAll()
        .where('id', '=', leadId)
        .executeTakeFirst();
    });

    expect(leadB).toBeUndefined();

    // Cleanup (under workspace A context)
    await withWorkspace(wsA, async (trx) => {
      await trx.deleteFrom('leads').where('id', '=', leadId).execute();
    });
  });
});
