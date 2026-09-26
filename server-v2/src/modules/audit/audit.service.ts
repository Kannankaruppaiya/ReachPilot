import { Injectable } from '@nestjs/common';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import pino from 'pino';

const logger = pino({ name: 'audit' });

export interface AuditEntry {
  workspaceId?: string;
  userId?: string;
  action: string;
  entity?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  ip?: string;
}

/** Audit log for security events (logins, secret access, limit changes). Never logs secrets. */
@Injectable()
export class AuditService {
  async log(entry: AuditEntry): Promise<void> {
    const values = {
      workspace_id: entry.workspaceId || null,
      user_id: entry.userId || null,
      action: entry.action,
      entity: entry.entity || null,
      entity_id: entry.entityId || null,
      meta: JSON.stringify(entry.meta || {}),
      ip: entry.ip || null,
    };
    try {
      const insert = (db: any) => db.insertInto('audit_log').values(values).execute();
      if (entry.workspaceId) {
        await withWorkspace(entry.workspaceId, insert);
      } else {
        await insert(getDb());
      }
    } catch (err) {
      logger.error({ err, action: entry.action }, 'Failed to write audit log');
    }
  }
}
