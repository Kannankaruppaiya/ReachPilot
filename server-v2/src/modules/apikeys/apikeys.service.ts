import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { getDb } from '@/db';

@Injectable()
export class ApiKeysService {
  async list(workspaceId: string): Promise<any[]> {
    const db = getDb();
    return db
      .selectFrom('api_keys')
      .select(['id', 'name', 'key_prefix', 'scopes', 'last_used_at', 'created_at'])
      .where('workspace_id', '=', workspaceId)
      .where('revoked_at', 'is', null)
      .execute();
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

    const randomPart = crypto.randomBytes(24).toString('hex');
    const token = `rp_live_${randomPart}`;
    const prefix = token.substring(0, 12);
    const hash = crypto.createHash('sha256').update(token).digest('hex');

    const db = getDb();

    const result = await db
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
      .executeTakeFirstOrThrow();

    return {
      id: result.id,
      name: result.name,
      keyPrefix: result.key_prefix,
      token,
    };
  }

  async revoke(workspaceId: string, id: string): Promise<void> {
    const db = getDb();
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
      .where('id', '=', id)
      .execute();
  }
}
