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
}

let dbInstance: Kysely<DatabaseSchema> | null = null;

export function getDb(): Kysely<DatabaseSchema> {
  if (dbInstance) return dbInstance;
  const env = getEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
  });
  dbInstance = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
  });
  return dbInstance;
}

export function createPool(): Pool {
  const env = getEnv();
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
  });
}
