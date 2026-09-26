import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';
import { hashApiKey, mintApiKeyToken } from './api-key-token';

// api_keys is RLS-scoped — every access runs under the workspace context.
@Injectable()
export class ApiKeysService {
  async list(workspaceId: string): Promise<any[]> {
    return withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('api_keys')
        .select(['id', 'name', 'key_prefix', 'scopes', 'last_used_at', 'created_at'])
        .where('workspace_id', '=', workspaceId)
        .where('revoked_at', 'is', null)
        .execute(),
    );
  }

  async create(
    workspaceId: string,
    userId: string,
    name: string,
    scopes: string[],
  ): Promise<{ id: string; name: string; keyPrefix: string; token: string }> {
    if (!name || !name.trim()) {
      throw new BadRequestException('API key name is required.');
    }

    // Embeds the workspace so the guard can scope the lookup (api-key-token.ts).
    const token = mintApiKeyToken(workspaceId);
    const prefix = token.substring(0, 12);
    const hash = hashApiKey(token);

    const result = await withWorkspace(workspaceId, (db) =>
      db
        .insertInto('api_keys')
        .values({
          workspace_id: workspaceId,
          created_by: userId,
          name: name.trim(),
          key_prefix: prefix,
          key_hash: hash,
          scopes,
        })
        .returning(['id', 'name', 'key_prefix'])
        .executeTakeFirstOrThrow(),
    );

    return {
      id: result.id,
      name: result.name,
      keyPrefix: result.key_prefix,
      token,
    };
  }

  async revoke(workspaceId: string, id: string): Promise<void> {
    await withWorkspace(workspaceId, async (db) => {
      const existing = await db
        .selectFrom('api_keys')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) {
        throw new NotFoundException('API key not found.');
      }

      await db
        .updateTable('api_keys')
        .set({ revoked_at: new Date().toISOString() })
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }
}
