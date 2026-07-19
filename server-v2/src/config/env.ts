import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  DATABASE_URL: z.string().url().default('postgresql://reachpilot:reachpilot@localhost:5432/reachpilot'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),

  AUTH_BYPASS: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().default('http://localhost:4000/api/auth/google/callback'),
  GOOGLE_INTEGRATION_CALLBACK_URL: z
    .string()
    .default('http://localhost:4000/api/integrations/google/callback'),
  APP_URL: z.string().default('http://localhost:5173'),

  // Email sending driver: 'simulator' (fake) or 'gmail' (real Gmail API).
  EMAIL_DRIVER: z.enum(['simulator', 'gmail']).default('simulator'),

  MASTER_KEY: z.string().length(64, 'MASTER_KEY must be 64 hex characters (32 bytes)'),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_FROM: z.string().default('noreply@reachpilot.dev'),

  // LinkedIn automation driver: 'simulator' (fake) or 'playwright' (real browser).
  LINKEDIN_DRIVER: z.enum(['simulator', 'playwright']).default('simulator'),
  PLAYWRIGHT_HEADLESS: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  PLAYWRIGHT_SLOWMO_MS: z.coerce.number().default(0),

  // How often the worker drains due `scheduled` jobs into the queues (ms).
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(30_000),

  // ── Background loop switches ────────────────────────────────────────────
  // The LinkedIn sync opens a REAL browser every few minutes (reads the
  // connections list + messaging, and withdraws stale invites). That's the
  // "pages keep opening by themselves" behaviour, and every extra automated
  // session is avoidable account risk while testing — so it can be switched off.
  // Off means: no acceptance/reply detection and no stale-invite withdrawal.
  LINKEDIN_SYNC_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  // Withdrawing invites older than WITHDRAW_AFTER_DAYS is destructive (it can
  // retract real, human-sent invitations), so it gets its own switch.
  LINKEDIN_WITHDRAW_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  WITHDRAW_AFTER_DAYS: z.coerce.number().int().positive().default(21),
  // Gmail inbox polling (API only — opens no browser).
  GMAIL_SYNC_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  // The scheduler drains due `scheduled` jobs. Off means multi-day sequences and
  // pacing-deferred retries never advance — only immediate day-0 sends run.
  SCHEDULER_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),

  // Residential/mobile proxy for LinkedIn egress (one dedicated IP per account).
  // Either a provider gateway (PROXY_SERVER + creds) or per-account IPs in the DB.
  PROXY_SERVER: z.string().default(''),
  PROXY_USERNAME: z.string().default(''),
  PROXY_PASSWORD: z.string().default(''),

  // AI personalization (Google Gemini). Free tier: gemini-2.5-flash, ~10 RPM /
  // 250 req/day. Empty key → the AI endpoints report "not configured" and callers
  // fall back to plain templates.
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(20),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_SEND_MAX: z.coerce.number().default(10),
  RATE_LIMIT_SEND_WINDOW_MS: z.coerce.number().default(60000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('debug'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`\n❌ Invalid environment variables:\n${formatted}\n`);
    process.exit(1);
  }
  cachedEnv = result.data;
  return cachedEnv;
}
