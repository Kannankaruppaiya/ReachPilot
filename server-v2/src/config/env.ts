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
  // Grace window where a just-rotated refresh token reused by a concurrent tab is
  // treated as a race (fresh tokens), not theft (401 + logout).
  REFRESH_ROTATION_GRACE_MS: z.coerce.number().int().nonnegative().default(30_000),

  // Lead scraper's persistent Chrome profile dir (empty = OS temp). Headful by
  // default; headless gets flagged by Google.
  SCRAPER_PROFILE_DIR: z.string().optional(),
  SCRAPER_HEADLESS: z.coerce.boolean().default(false),
  // Lead-scraper engine: 'legacy' (single-page patchright), 'crawlee' (pagination +
  // session rotation) or 'multi' (rotates search engines with block cooldowns).
  SCRAPER_ENGINE: z.enum(['legacy', 'crawlee', 'multi']).default('legacy'),
  // Engines for 'multi', tried left to right: google, bing, duckduckgo, brave, mojeek.
  SCRAPER_ENGINES: z.string().default('google,bing,duckduckgo,brave'),
  // Pause an engine this long (ms) after it returns a block/CAPTCHA.
  SCRAPER_ENGINE_COOLDOWN_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),

  // Standalone scraper service (src/scraper-service.ts, `npm run start:scraper`).
  // Set SCRAPER_SERVICE_URL on the worker to offload to it; empty = scrape locally.
  SCRAPER_SERVICE_PORT: z.coerce.number().int().positive().default(4100),
  SCRAPER_SERVICE_TOKEN: z.string().default(''),
  SCRAPER_SERVICE_URL: z.string().default(''),

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

  // LinkedIn driver: 'simulator' (fake), 'playwright' (local browser) or 'remote' (desktop agent).
  LINKEDIN_DRIVER: z.enum(['simulator', 'playwright', 'remote']).default('simulator'),
  PLAYWRIGHT_HEADLESS: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  PLAYWRIGHT_SLOWMO_MS: z.coerce.number().default(0),

  // How often the worker drains due `scheduled` jobs into the queues (ms).
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(30_000),

  // Campaign runner; off means enrollments never advance past their first step.
  CAMPAIGN_RUNNER_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  CAMPAIGN_RUNNER_TICK_MS: z.coerce.number().int().positive().default(60_000),

  // ── Background loop switches ────────────────────────────────────────────
  // LinkedIn sync opens a real browser every tick; switch it off while testing.
  // Off = no acceptance/reply detection and no stale-invite withdrawal.
  LINKEDIN_SYNC_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  // Withdrawing old invites is destructive, so it has its own switch.
  LINKEDIN_WITHDRAW_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  WITHDRAW_AFTER_DAYS: z.coerce.number().int().positive().default(21),
  // LinkedIn sync interval. Each tick opens a real browser per account, so keep it long.
  LINKEDIN_SYNC_TICK_MS: z.coerce.number().int().positive().default(45 * 60 * 1000),
  // Gmail inbox polling (API only — opens no browser).
  GMAIL_SYNC_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  // Scheduler; off means only immediate day-0 sends run.
  SCHEDULER_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  // Email warm-up between the workspace's mailboxes (needs ≥2 mailboxes and the
  // gmail.modify scope). API only.
  EMAIL_WARMUP_ENABLED: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('false'),
  EMAIL_WARMUP_TICK_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  // Ceiling for the per-mailbox daily warm-up send budget (ramp: 2 + age/2 days).
  EMAIL_WARMUP_MAX_PER_DAY: z.coerce.number().int().positive().default(8),

  // LinkedIn egress proxy: a provider gateway here, or per-account IPs in the DB.
  PROXY_SERVER: z.string().default(''),
  PROXY_USERNAME: z.string().default(''),
  PROXY_PASSWORD: z.string().default(''),

  // Gemini for AI personalisation. Empty → AI endpoints report "not configured" and
  // callers use plain templates.
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  // Apify MCP endpoint; each workspace's own Apify token (vault) authorises calls.
  APIFY_MCP_URL: z.string().default('https://mcp.apify.com'),
  APIFY_MCP_DEFAULT_TOOLS: z.string().default('actors,docs,apify/rag-web-browser'),

  // Apify actor for "AI + Apify" connect notes (scrapes the prospect's profile).
  // Input key and mode are actor-specific, so a different actor can be set in .env.
  APIFY_LINKEDIN_ACTOR: z.string().default('harvestapi/linkedin-profile-scraper'),
  APIFY_LINKEDIN_INPUT_KEY: z.string().default('queries'),
  APIFY_LINKEDIN_MODE: z.string().default('Profile details no email ($4 per 1k)'),

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
