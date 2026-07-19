import { Injectable, BadRequestException } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';

@Injectable()
export class WorkspacesService {
  async create(name: string, goal: string, userId: string): Promise<any> {
    if (!name || !name.trim()) {
      throw new BadRequestException('Workspace name is required.');
    }
    const db = getDb();
    const workspace = await db
      .insertInto('workspaces')
      .values({
        name: name.trim(),
        goal: goal || 'Sales',
        onboarding_step: 1,
      })
      .returning(['id', 'name', 'goal', 'created_at'])
      .executeTakeFirstOrThrow();

    await db
      .insertInto('memberships')
      .values({
        workspace_id: workspace.id,
        user_id: userId,
        role: 'owner',
      })
      .execute();

    return workspace;
  }

  async updateOnboardingStep(workspaceId: string, step: number): Promise<void> {
    const db = getDb();
    await db
      .updateTable('workspaces')
      .set((eb: any) => ({
        onboarding_step: eb.fn('greatest', [eb.ref('onboarding_step'), eb.val(step)]),
      }))
      .where('id', '=', workspaceId)
      .execute();
  }

  async completeOnboarding(workspaceId: string): Promise<void> {
    const db = getDb();
    await db
      .updateTable('workspaces')
      .set({ onboarding_done: true, onboarding_step: 6 })
      .where('id', '=', workspaceId)
      .execute();
  }

  async resetOnboarding(workspaceId: string): Promise<void> {
    const db = getDb();
    await db
      .updateTable('workspaces')
      .set({ onboarding_done: false, onboarding_step: 0, name: '', goal: 'Sales' })
      .where('id', '=', workspaceId)
      .execute();

    await db
      .deleteFrom('linkedin_accounts')
      .where('workspace_id', '=', workspaceId)
      .execute();

    await db
      .deleteFrom('email_accounts')
      .where('workspace_id', '=', workspaceId)
      .execute();
  }

  async getWorkspace(workspaceId: string): Promise<any> {
    const db = getDb();
    return db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', workspaceId)
      .executeTakeFirst();
  }

  async updateWorkspace(workspaceId: string, data: { name?: string; goal?: string }): Promise<any> {
    const db = getDb();
    const updates: Record<string, any> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.goal !== undefined) updates.goal = data.goal;

    if (Object.keys(updates).length === 0) return this.getWorkspace(workspaceId);

    await db
      .updateTable('workspaces')
      .set(updates)
      .where('id', '=', workspaceId)
      .execute();

    return this.getWorkspace(workspaceId);
  }
}
