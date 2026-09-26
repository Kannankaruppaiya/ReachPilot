import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { sql } from 'kysely';
import { KeyManagementService } from './key-management.service';
import { AuditService } from '@/modules/audit/audit.service';

/**
 * AES-256-GCM envelope encryption. Each secret is encrypted with a DEK, which is
 * wrapped by the master key (KeyManagementService). Never log plaintext.
 */
@Injectable()
export class SecretsService {
  constructor(
    private readonly kms: KeyManagementService,
    private readonly audit: AuditService,
  ) {}

  /** Encrypt and store a value; returns the secret id. */
  async encrypt(
    plaintext: string,
    kind: string,
    options: {
      workspaceId?: string;
      userId?: string;
    },
  ): Promise<string> {
    const { keyId, plaintextKey } = await this.kms.generateDataKey();

    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', plaintextKey, nonce);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([encrypted, authTag]);

    const doInsert = async (db: any) => {
      const row = await db
        .insertInto('secrets')
        .values({
          workspace_id: options.workspaceId || null,
          user_id: options.userId || null,
          kind,
          key_id: keyId,
          nonce,
          ciphertext,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id as string;
    };

    if (options.workspaceId) {
      return withWorkspace(options.workspaceId, doInsert);
    }
    return doInsert(getDb());
  }

  /** Decrypt a secret by id; the access is audited. */
  async decrypt(
    secretId: string,
    auditContext?: { userId?: string; workspaceId?: string; ip?: string },
  ): Promise<string> {
    const doDecrypt = async (db: any) => {
      const row = await db
        .selectFrom('secrets')
        .select(['key_id', 'nonce', 'ciphertext'])
        .where('id', '=', secretId)
        .executeTakeFirstOrThrow();

      const plaintextKey = await this.kms.getDataKey(row.key_id);

      const ciphertextBuf = row.ciphertext as Buffer;
      const authTag = ciphertextBuf.subarray(ciphertextBuf.length - 16);
      const encryptedData = ciphertextBuf.subarray(0, ciphertextBuf.length - 16);
      const nonce = row.nonce as Buffer;

      const decipher = crypto.createDecipheriv('aes-256-gcm', plaintextKey, nonce);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
      ]);

      if (auditContext) {
        await this.audit.log({
          userId: auditContext.userId,
          workspaceId: auditContext.workspaceId,
          action: 'secret.read',
          entity: 'secret',
          entityId: secretId,
          ip: auditContext.ip,
        });
      }

      return decrypted.toString('utf8');
    };

    if (auditContext?.workspaceId) {
      return withWorkspace(auditContext.workspaceId, doDecrypt);
    }
    // No workspace given: resolve it from the secret row.
    const db = getDb();
    return db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.workspace_id', COALESCE((SELECT workspace_id::text FROM secrets WHERE id = ${secretId}), ''), true)`.execute(trx);
      return doDecrypt(trx);
    });
  }

  async remove(secretId: string, workspaceId?: string): Promise<void> {
    const doDelete = async (db: any) => {
      await db.deleteFrom('secrets').where('id', '=', secretId).execute();
    };

    if (workspaceId) {
      return withWorkspace(workspaceId, doDelete);
    }
    // No workspace given: resolve it from the secret row.
    const db = getDb();
    return db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.workspace_id', COALESCE((SELECT workspace_id::text FROM secrets WHERE id = ${secretId}), ''), true)`.execute(trx);
      return doDelete(trx);
    });
  }
}
