import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { sql } from 'kysely';
import { KeyManagementService } from './key-management.service';
import { AuditService } from '@/modules/audit/audit.service';

/**
 * Secrets service implementing AES-256-GCM envelope encryption.
 *
 * Every secret (LinkedIn password, TOTP codes, OAuth tokens, etc.) is
 * encrypted with a DEK (data encryption key). The DEK itself is wrapped
 * by the master key and stored in `encryption_keys`.
 *
 * Flow for encrypt:
 *   1. Generate or reuse a DEK (via KeyManagementService).
 *   2. Generate a random 12-byte GCM nonce.
 *   3. Encrypt plaintext with DEK using AES-256-GCM.
 *   4. Store ciphertext + nonce + key_id in `secrets` table.
 *
 * Flow for decrypt:
 *   1. Load secret row (ciphertext, nonce, key_id).
 *   2. Unwrap the DEK via KeyManagementService.
 *   3. Decrypt ciphertext with DEK + nonce.
 *   4. Return plaintext (NEVER log it).
 */
@Injectable()
export class SecretsService {
  constructor(
    private readonly kms: KeyManagementService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Encrypts a plaintext value and stores it in the secrets table.
   * Returns the secret row ID.
   */
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

    // Use withWorkspace to set RLS context when workspaceId is available
    if (options.workspaceId) {
      return withWorkspace(options.workspaceId, doInsert);
    }
    return doInsert(getDb());
  }

  /**
   * Decrypts a secret by its ID. Returns the plaintext string.
   * Logs an audit entry for the access.
   */
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
    // Fallback: resolve workspace from the secret row using subquery
    const db = getDb();
    return db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.workspace_id', COALESCE((SELECT workspace_id::text FROM secrets WHERE id = ${secretId}), ''), true)`.execute(trx);
      return doDecrypt(trx);
    });
  }

  /**
   * Deletes a secret by ID.
   */
  async remove(secretId: string, workspaceId?: string): Promise<void> {
    const doDelete = async (db: any) => {
      await db.deleteFrom('secrets').where('id', '=', secretId).execute();
    };

    if (workspaceId) {
      return withWorkspace(workspaceId, doDelete);
    }
    // Fallback: resolve workspace from the row
    const db = getDb();
    return db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.workspace_id', COALESCE((SELECT workspace_id::text FROM secrets WHERE id = ${secretId}), ''), true)`.execute(trx);
      return doDelete(trx);
    });
  }
}
