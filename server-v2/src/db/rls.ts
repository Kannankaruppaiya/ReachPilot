import { Kysely, sql } from 'kysely';
import { DatabaseSchema, getDb } from './kysely';

/**
 * Run `callback` in a transaction with `SET LOCAL app.workspace_id`, so every RLS
 * policy filters to that workspace. Reverts on commit/rollback.
 */
export async function withWorkspace<T>(
  workspaceId: string,
  callback: (trx: Kysely<DatabaseSchema>) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`.execute(trx);
    return callback(trx);
  });
}

/** Run `callback` in a transaction with no tenant scope (users, sessions, tokens). */
export async function withoutTenant<T>(
  callback: (trx: Kysely<DatabaseSchema>) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    return callback(trx);
  });
}
