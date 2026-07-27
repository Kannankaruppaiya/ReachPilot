import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { getEnv } from '@/config/env';

export interface DatabaseSchema {
  users: any;
  oauth_identities: any;
  user_sessions: any;
  password_reset_tokens: any;
  email_verification_tokens: any;
  user_mfa: any;
  mfa_backup_codes: any;
  workspaces: any;
  memberships: any;
  invitations: any;
  api_keys: any;
  encryption_keys: any;
  secrets: any;
  proxies: any;
  linkedin_accounts: any;
  email_accounts: any;
  leads: any;
  blacklist: any;
  templates: any;
  campaigns: any;
  campaign_steps: any;
  ab_tests: any;
  ab_variants: any;
  enrollments: any;
  jobs: any;
  threads: any;
  messages: any;
  integrations: any;
  webhook_endpoints: any;
  webhook_deliveries: any;
  notifications: any;
  activity: any;
  audit_log: any;
  plans: any;
  subscriptions: any;
  invoices: any;
  daily_stats: any;
  hourly_stats: any;
  campaign_stats: any;
  template_stats: any;
  ai_conversations: any;
  ai_messages: any;
}

let dbInstance: Kysely<DatabaseSchema> | null = null;

/**
 * Attach an idle-client error handler to a pool. Pooled Postgres (the Supabase
 * session pooler especially) drops idle connections; `pg` then emits an 'error'
 * event on the Pool for the dropped client. With no listener that surfaces as an
 * uncaught exception and CRASHES the process (the API/worker "exit 1" seen on
 * pooler drops). Logging it — and letting pg evict the dead client so the next
 * query gets a fresh connection — keeps the service alive.
 */
function withPoolErrorHandler(pool: Pool): Pool {
  pool.on('error', (err) => {
    console.warn(`[db] idle pool client error (non-fatal, connection evicted): ${err.message}`);
  });
  return pool;
}

export function getDb(): Kysely<DatabaseSchema> {
  if (dbInstance) return dbInstance;
  const env = getEnv();
  const pool = withPoolErrorHandler(
    new Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
    }),
  );
  dbInstance = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
  });
  return dbInstance;
}

export function createPool(): Pool {
  const env = getEnv();
  return withPoolErrorHandler(
    new Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
    }),
  );
}
