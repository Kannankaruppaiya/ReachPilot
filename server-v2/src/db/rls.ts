import { Kysely, sql } from 'kysely';
import { DatabaseSchema, getDb } from './kysely';

/**
 * Executes a callback inside a PostgreSQL transaction with RLS tenant scoping.
 *
 * Before any user query runs, we `SET LOCAL app.workspace_id = '<uuid>'` so that
 * every RLS policy on tenant-scoped tables automatically filters by that workspace.
 * SET LOCAL is transaction-scoped — it reverts on COMMIT/ROLLBACK.
 *
 * @param workspaceId The UUID of the workspace to scope the transaction to.
 * @param callback    A function that receives the transactional Kysely instance.
 * @returns           The return value of the callback.
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

/**
 * Executes a callback inside a transaction WITHOUT RLS scoping.
 * Used for auth/identity queries (users, sessions, tokens) that are not
 * workspace-scoped and should bypass tenant isolation policies.
 *
 * @param callback A function that receives the transactional Kysely instance.
 * @returns        The return value of the callback.
 */
export async function withoutTenant<T>(
  callback: (trx: Kysely<DatabaseSchema>) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    return callback(trx);
  });
}
