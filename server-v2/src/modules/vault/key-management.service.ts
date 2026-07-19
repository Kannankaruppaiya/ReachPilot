import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { getEnv } from '@/config/env';
import { getDb } from '@/db';

/**
 * Manages data encryption keys (DEKs) using envelope encryption.
 *
 * Architecture:
 * - A master key (from MASTER_KEY env var) wraps/unwraps DEKs.
 * - DEKs are stored in the encryption_keys table, wrapped by the master key.
 * - This class provides the abstraction layer so a real KMS (AWS KMS, GCP KMS)
 *   can be swapped in by implementing the same interface.
 *
 * The master key is AES-256 (32 bytes) and the DEKs are also AES-256.
 * Wrapping uses AES-256-GCM with a random IV per wrap operation.
 */
@Injectable()
export class KeyManagementService {
  private getMasterKey(): Buffer {
    const env = getEnv();
    return Buffer.from(env.MASTER_KEY, 'hex');
  }

  /**
   * Wraps (encrypts) a DEK with the master key using AES-256-GCM.
   * Returns the wrapped key as a single buffer: [12-byte IV][ciphertext][16-byte auth tag]
   */
  wrapKey(plaintextKey: Buffer): Buffer {
    const masterKey = this.getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, authTag]);
  }

  /**
   * Unwraps (decrypts) a DEK using the master key.
   * Expects the format: [12-byte IV][ciphertext][16-byte auth tag]
   */
  unwrapKey(wrappedKey: Buffer): Buffer {
    const masterKey = this.getMasterKey();
    const iv = wrappedKey.subarray(0, 12);
    const authTag = wrappedKey.subarray(wrappedKey.length - 16);
    const ciphertext = wrappedKey.subarray(12, wrappedKey.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /**
   * Generates a new DEK, wraps it with the master key, stores it in the
   * encryption_keys table, and returns both the plaintext DEK and its row ID.
   */
  async generateDataKey(): Promise<{ keyId: string; plaintextKey: Buffer }> {
    const plaintextKey = crypto.randomBytes(32);
    const wrappedKey = this.wrapKey(plaintextKey);

    const db = getDb();
    const row = await db
      .insertInto('encryption_keys')
      .values({
        wrapped_key: wrappedKey,
        algorithm: 'aes-256-gcm',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { keyId: row.id, plaintextKey };
  }

  /**
   * Retrieves and unwraps a DEK by its row ID.
   */
  async getDataKey(keyId: string): Promise<Buffer> {
    const db = getDb();
    const row = await db
      .selectFrom('encryption_keys')
      .select('wrapped_key')
      .where('id', '=', keyId)
      .executeTakeFirstOrThrow();

    return this.unwrapKey(row.wrapped_key);
  }
}
