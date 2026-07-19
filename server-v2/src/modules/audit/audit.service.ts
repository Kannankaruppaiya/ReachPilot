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

/**
 * Writes rows to the audit_log table for security-relevant events:
 * logins, secret access, limit changes, exports, etc.
 * Never logs secrets, passwords, or tokens.
 */
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
      // audit_log is RLS-scoped — write under the workspace context when known.
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
