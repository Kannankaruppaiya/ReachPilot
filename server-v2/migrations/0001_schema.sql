-- ============================================================================
-- ReachPilot — PostgreSQL schema (v2, complete)
-- Covers the ENTIRE application flow observed in the frontend:
--   signup / signin (email+password, Google OAuth, forgot password)
--   sessions & refresh tokens, app-login 2FA, API keys
--   encrypted secret storage (LinkedIn password, session cookies, TOTP/2FA
--   secrets, Gmail OAuth tokens, integration credentials)
--   onboarding (workspace → LinkedIn+IP → 2FA → Gmail → warm-up → leads)
--   leads, templates, A/B tests, smart-campaign graph, jobs/send queue,
--   unified inbox, integrations, webhooks, notifications, activity,
--   billing (Pro/Agency plans), analytics (daily + hourly heatmap)
--
-- Requires PostgreSQL 15+.
-- Field names mirror the demo backend (server/index.js) so API routes map 1:1.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive emails

-- ============================================================================
-- 1. Enums
-- ============================================================================

CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'member');

CREATE TYPE account_status AS ENUM
  ('connecting', 'active', 'warming_up', 'paused', 'checkpoint', 'disconnected');

CREATE TYPE twofa_status AS ENUM ('not_set', 'verified', 'skipped');

CREATE TYPE lead_status AS ENUM
  ('new', 'invited', 'accepted', 'replied', 'unqualified', 'blacklisted');

CREATE TYPE channel AS ENUM ('linkedin', 'email');

CREATE TYPE campaign_status AS ENUM ('draft', 'active', 'paused', 'archived');

CREATE TYPE step_kind AS ENUM ('action', 'condition');

CREATE TYPE action_type AS ENUM
  ('visit_profile', 'follow', 'connect_request', 'linkedin_message', 'inmail',
   'like_post', 'endorse_skill', 'send_email', 'wait', 'enrich',
   'fire_webhook', 'move_to_campaign', 'add_tag');

CREATE TYPE condition_type AS ENUM
  ('if_connected', 'if_replied', 'if_email_opened', 'if_email_clicked',
   'if_inmail_opened', 'if_profile_visited', 'if_post_liked',
   'if_followed_by_you', 'if_has_email');

CREATE TYPE enrollment_status AS ENUM
  ('active', 'waiting', 'paused', 'replied', 'finished', 'stopped', 'failed');

CREATE TYPE job_status AS ENUM
  ('scheduled', 'queued', 'running', 'sent', 'failed', 'canceled');

CREATE TYPE message_direction AS ENUM ('me', 'them');

CREATE TYPE delivery_status AS ENUM ('pending', 'delivered', 'failed', 'dead');

CREATE TYPE dns_check AS ENUM ('pass', 'fail', 'not_set');   -- SPF/DKIM/DMARC panel

CREATE TYPE subscription_status AS ENUM
  ('trialing', 'active', 'past_due', 'canceled');

CREATE TYPE secret_kind AS ENUM
  ('linkedin_password',      -- LinkedIn login password (onboarding step 2)
   'linkedin_session',       -- session cookies captured by the login worker
   'linkedin_totp',          -- authenticator/2FA base32 secret (step 3)
   'email_oauth',            -- Gmail/O365 OAuth refresh token (step 4)
   'email_smtp',             -- SMTP credentials
   'integration_credentials',-- Smartlead/HubSpot/Zapier API keys
   'user_totp');             -- app-login 2FA secret for ReachPilot users

-- ============================================================================
-- 2. Authentication & identity  (signup / signin flow)
-- ============================================================================

-- Signup: INSERT users (password_hash = Argon2id) + email_verification_tokens.
-- Signin: verify hash → create user_sessions row → issue access JWT (short) +
--         refresh token (stored HASHED here, never plaintext).
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  email_verified_at timestamptz,
  password_hash     text,                     -- Argon2id; NULL = Google-only account
  full_name         text NOT NULL,
  avatar_url        text,
  last_login_at     timestamptz,
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- "Continue with Google" on the login screen. One user can link many providers.
CREATE TABLE oauth_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_user_id text NOT NULL,             -- Google `sub` claim
  email            citext,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

-- One row per device login. Refresh-token rotation: on use, revoke + insert.
CREATE TABLE user_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,    -- sha256(token); plaintext only in cookie
  user_agent         text,
  ip                 inet,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);
CREATE INDEX sessions_by_user ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- "Forgot password?" — single-use, short-lived, hashed tokens.
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_verification_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Optional app-login 2FA for ReachPilot users themselves (TOTP).
-- The secret lives in `secrets` (encrypted), referenced from here.
CREATE TABLE user_mfa (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret_id uuid,                        -- FK to secrets, added below
  enabled_at     timestamptz,
  last_used_at   timestamptz
);

CREATE TABLE mfa_backup_codes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,                    -- Argon2id; single use
  used_at   timestamptz
);

-- ============================================================================
-- 3. Tenancy — workspaces, membership, invitations
-- ============================================================================

CREATE TABLE workspaces (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,             -- "RJP Infotek Outbound"
  goal             text NOT NULL DEFAULT 'Sales',
  branding         jsonb NOT NULL DEFAULT '{}',   -- white-label (Agency plan)
  onboarding_step  smallint NOT NULL DEFAULT 0,   -- demo: completedStep 0..6
  onboarding_done  boolean  NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  role         membership_role NOT NULL DEFAULT 'member',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- "Unlimited teammates/clients" — email invites with hashed tokens.
CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  role         membership_role NOT NULL DEFAULT 'member',
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

-- Workspace-scoped API keys (public API / webhook management).
-- Show plaintext ONCE at creation; store only prefix + hash.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_prefix   text NOT NULL,                 -- "rp_live_a1b2…" for display
  key_hash     text NOT NULL UNIQUE,          -- sha256 of full key
  scopes       text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 4. Secrets vault & key management
-- Every credential the product must hold (LinkedIn password, session cookies,
-- 2FA/TOTP secrets, Gmail OAuth tokens, integration API keys) lives here as
-- AES-256-GCM ciphertext under an envelope-encrypted data key. No table ever
-- stores a third-party credential in plaintext.
-- ============================================================================

-- Data-encryption keys (DEKs), themselves wrapped by the KMS master key.
CREATE TABLE encryption_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wrapped_key    bytea NOT NULL,              -- DEK encrypted by KMS master key
  algorithm      text NOT NULL DEFAULT 'aes-256-gcm',
  created_at     timestamptz NOT NULL DEFAULT now(),
  retired_at     timestamptz                  -- set on rotation; old rows kept to decrypt
);

CREATE TABLE secrets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,  -- NULL for user_totp
  user_id      uuid REFERENCES users(id)      ON DELETE CASCADE,
  kind         secret_kind NOT NULL,
  key_id       uuid NOT NULL REFERENCES encryption_keys(id),
  nonce        bytea NOT NULL,                -- per-secret GCM IV
  ciphertext   bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz,
  CHECK (workspace_id IS NOT NULL OR user_id IS NOT NULL)
);
CREATE INDEX secrets_by_workspace ON secrets (workspace_id, kind);

ALTER TABLE user_mfa
  ADD CONSTRAINT user_mfa_secret_fk
  FOREIGN KEY (totp_secret_id) REFERENCES secrets(id) ON DELETE SET NULL;

-- ============================================================================
-- 5. Connected accounts & proxy infrastructure
-- ============================================================================

CREATE TABLE proxies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider   text NOT NULL,
  ip         inet NOT NULL,
  country    text NOT NULL,
  healthy    boolean NOT NULL DEFAULT true,
  last_check timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Onboarding step 2 (LinkedIn email+password+country → dedicated IP) and
-- step 3 (authenticator secret). Credentials live in `secrets`.
CREATE TABLE linkedin_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  email               citext NOT NULL,
  country             text NOT NULL,
  proxy_id            uuid UNIQUE REFERENCES proxies(id),      -- dedicated IP, pinned
  password_secret_id  uuid REFERENCES secrets(id) ON DELETE SET NULL,
  session_secret_id   uuid REFERENCES secrets(id) ON DELETE SET NULL,
  totp_secret_id      uuid REFERENCES secrets(id) ON DELETE SET NULL,
  twofa               twofa_status NOT NULL DEFAULT 'not_set',
  status              account_status NOT NULL DEFAULT 'connecting',
  -- warm-up & limits (onboarding step 5 + Settings → LinkedIn limits)
  warmup_daily_limit  smallint NOT NULL DEFAULT 18
                      CHECK (warmup_daily_limit BETWEEN 1 AND 45),
  warmup_target       smallint NOT NULL DEFAULT 45,
  weekly_invite_cap   smallint NOT NULL DEFAULT 100,   -- LinkedIn ~100/week rule
  hours_start         time NOT NULL DEFAULT '09:00',
  hours_end           time NOT NULL DEFAULT '18:00',
  send_weekends       boolean NOT NULL DEFAULT false,
  timezone            text NOT NULL DEFAULT 'UTC',
  last_sync_at        timestamptz,                     -- "last sync 4 min ago"
  connected_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

-- Onboarding step 4 (Gmail) + Sequences screen deliverability panel.
CREATE TABLE email_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  provider              text NOT NULL DEFAULT 'gmail',  -- gmail | o365 | smtp | smartlead
  email                 citext NOT NULL,
  credentials_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  daily_limit           smallint NOT NULL DEFAULT 50
                        CHECK (daily_limit BETWEEN 20 AND 150),
  status                account_status NOT NULL DEFAULT 'active',
  spf_status            dns_check NOT NULL DEFAULT 'not_set',
  dkim_status           dns_check NOT NULL DEFAULT 'not_set',
  dmarc_status          dns_check NOT NULL DEFAULT 'not_set',
  dns_checked_at        timestamptz,
  connected_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

-- ============================================================================
-- 6. Leads & blacklist
-- ============================================================================

CREATE TABLE leads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  full_name      text NOT NULL,
  first_name     text NOT NULL,
  title          text NOT NULL DEFAULT '',
  company        text NOT NULL DEFAULT '',
  location       text NOT NULL DEFAULT '',
  linkedin_url   text,
  email          citext,
  email_verified boolean NOT NULL DEFAULT false,
  status         lead_status NOT NULL DEFAULT 'new',
  source         text,
  tags           text[] NOT NULL DEFAULT '{}',
  enrichment     jsonb NOT NULL DEFAULT '{}',
  last_activity  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX leads_dedup_linkedin
  ON leads (workspace_id, lower(linkedin_url)) WHERE linkedin_url IS NOT NULL;
CREATE UNIQUE INDEX leads_dedup_email
  ON leads (workspace_id, email) WHERE email IS NOT NULL;
CREATE INDEX leads_by_status ON leads (workspace_id, status);
CREATE INDEX leads_tags_gin  ON leads USING gin (tags);

-- Settings → Blacklist ("never contact these domains") + person-level blocks.
CREATE TABLE blacklist (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('linkedin_url', 'email', 'company_domain')),
  value        citext NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, value)
);

-- ============================================================================
-- 7. Templates & A/B testing
-- ============================================================================

CREATE TABLE templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  channel      channel NOT NULL,
  subject      text,
  body         text NOT NULL,                 -- {{firstName|there}} placeholders
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 8. Campaigns — smart-sequence graph
-- ============================================================================

CREATE TABLE campaigns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                text NOT NULL,
  status              campaign_status NOT NULL DEFAULT 'draft',
  daily_cap           smallint NOT NULL DEFAULT 15 CHECK (daily_cap >= 1),
  linkedin_account_id uuid REFERENCES linkedin_accounts(id) ON DELETE SET NULL,
  email_account_id    uuid REFERENCES email_accounts(id)    ON DELETE SET NULL,
  entry_step_id       uuid,                   -- FK added after campaign_steps
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_steps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind             step_kind NOT NULL,
  action           action_type,
  condition        condition_type,
  template_id      uuid REFERENCES templates(id) ON DELETE SET NULL,
  params           jsonb NOT NULL DEFAULT '{}',
  delay_hours      integer NOT NULL DEFAULT 0 CHECK (delay_hours >= 0),
  next_step_id     uuid REFERENCES campaign_steps(id) ON DELETE SET NULL,
  on_true_step_id  uuid REFERENCES campaign_steps(id) ON DELETE SET NULL,
  on_false_step_id uuid REFERENCES campaign_steps(id) ON DELETE SET NULL,
  position         jsonb NOT NULL DEFAULT '{}',
  CHECK (
    (kind = 'action'    AND action    IS NOT NULL AND condition IS NULL) OR
    (kind = 'condition' AND condition IS NOT NULL AND action    IS NULL)
  )
);
CREATE INDEX steps_by_campaign ON campaign_steps (campaign_id);

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_entry_step_fk
  FOREIGN KEY (entry_step_id) REFERENCES campaign_steps(id) ON DELETE SET NULL;

-- Analytics → "A/B test — connection note": variants of one step's message.
CREATE TABLE ab_tests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_id      uuid REFERENCES campaign_steps(id) ON DELETE CASCADE,
  name         text NOT NULL,
  metric       text NOT NULL DEFAULT 'accepted' CHECK (metric IN ('accepted', 'replied')),
  min_sends    smallint NOT NULL DEFAULT 30,   -- "needs 30+ for confidence"
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'won', 'stopped')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ab_variants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id     uuid NOT NULL REFERENCES ab_tests(id) ON DELETE CASCADE,
  label       text NOT NULL,                  -- 'A', 'B'
  template_id uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  UNIQUE (test_id, label)
);

CREATE TABLE enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id     uuid NOT NULL REFERENCES campaigns(id)  ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES leads(id)      ON DELETE CASCADE,
  current_step_id uuid REFERENCES campaign_steps(id) ON DELETE SET NULL,
  status          enrollment_status NOT NULL DEFAULT 'active',
  next_run_at     timestamptz,
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX enrollments_due
  ON enrollments (next_run_at) WHERE status IN ('active', 'waiting');

-- ============================================================================
-- 9. Jobs — durable send queue (demo's sendJobs)
-- ============================================================================

CREATE TABLE jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  batch_id            uuid,                   -- Auto Connect / Auto Mail batches
  campaign_id         uuid REFERENCES campaigns(id)      ON DELETE SET NULL,
  enrollment_id       uuid REFERENCES enrollments(id)    ON DELETE SET NULL,
  step_id             uuid REFERENCES campaign_steps(id) ON DELETE SET NULL,
  lead_id             uuid REFERENCES leads(id)          ON DELETE SET NULL,
  linkedin_account_id uuid REFERENCES linkedin_accounts(id) ON DELETE SET NULL,
  email_account_id    uuid REFERENCES email_accounts(id)    ON DELETE SET NULL,
  ab_variant_id       uuid REFERENCES ab_variants(id)    ON DELETE SET NULL,
  kind                channel NOT NULL,
  action              action_type NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}',   -- rendered message/subject/target
  status              job_status NOT NULL DEFAULT 'scheduled',
  scheduled_for       timestamptz NOT NULL,
  sent_at             timestamptz,
  attempts            smallint NOT NULL DEFAULT 0,
  last_error          text,
  idempotency_key     text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_dispatch  ON jobs (status, scheduled_for);
CREATE INDEX jobs_per_account
  ON jobs (linkedin_account_id, status) WHERE linkedin_account_id IS NOT NULL;
CREATE INDEX jobs_by_batch  ON jobs (batch_id);
CREATE INDEX jobs_by_lead   ON jobs (lead_id);

-- ============================================================================
-- 10. Unified inbox
-- ============================================================================

CREATE TABLE threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel         channel NOT NULL,
  unread          boolean NOT NULL DEFAULT false,
  labels          text[] NOT NULL DEFAULT '{}',
  notes           text,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, channel)
);
CREATE INDEX threads_unread ON threads (workspace_id, unread, last_message_at DESC);

CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction   message_direction NOT NULL,
  channel     channel NOT NULL,
  subject     text,
  body        text NOT NULL,
  external_id text,                           -- LinkedIn/Gmail message id (dedup)
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, external_id)
);
CREATE INDEX messages_by_thread ON messages (thread_id, sent_at);

-- ============================================================================
-- 11. Integrations, webhooks, notifications, activity, audit
-- ============================================================================

CREATE TABLE integrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider              text NOT NULL,        -- smartlead | hubspot | zapier…
  config                jsonb NOT NULL DEFAULT '{}',
  credentials_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);

CREATE TABLE webhook_endpoints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url          text NOT NULL,
  secret       text NOT NULL,                 -- HMAC signing key
  events       text[] NOT NULL DEFAULT '{}',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id   uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  status        delivery_status NOT NULL DEFAULT 'pending',
  attempts      smallint NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_pending
  ON webhook_deliveries (next_retry_at) WHERE status = 'pending';

-- Header bell (unread count badge). user_id NULL = whole-workspace notice.
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL,                 -- reply_received | account_paused | …
  text         text NOT NULL,
  refs         jsonb NOT NULL DEFAULT '{}',
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread
  ON notifications (workspace_id, user_id, created_at DESC) WHERE read_at IS NULL;

-- Dashboard activity feed (demo's db.activity).
CREATE TABLE activity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  text         text NOT NULL,
  tone         text NOT NULL DEFAULT 'sub',
  refs         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_feed ON activity (workspace_id, created_at DESC);

-- Security/audit trail: logins, secret access, limit changes, exports.
CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id      uuid REFERENCES users(id)      ON DELETE SET NULL,
  action       text NOT NULL,                 -- user.login | secret.read | limits.update…
  entity       text,
  entity_id    uuid,
  meta         jsonb NOT NULL DEFAULT '{}',
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_by_workspace ON audit_log (workspace_id, created_at DESC);

-- ============================================================================
-- 12. Billing — Settings → Billing (Pro $79 / Agency $249)
-- ============================================================================

CREATE TABLE plans (
  id                    text PRIMARY KEY,     -- 'pro', 'agency'
  name                  text NOT NULL,
  price_cents           integer NOT NULL,
  currency              text NOT NULL DEFAULT 'USD',
  max_linkedin_accounts smallint NOT NULL,
  features              jsonb NOT NULL DEFAULT '{}'
);

INSERT INTO plans (id, name, price_cents, max_linkedin_accounts, features) VALUES
  ('pro',    'Pro',    7900,  1, '{"campaigns": "unlimited", "sequences": ["email", "linkedin"]}'),
  ('agency', 'Agency', 24900, 5, '{"roles": true, "white_label": true}');

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id              text NOT NULL REFERENCES plans(id),
  status               subscription_status NOT NULL DEFAULT 'trialing',
  external_customer_id text,                  -- Stripe customer
  current_period_start timestamptz,
  current_period_end   timestamptz,
  canceled_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  external_id     text UNIQUE,                -- Stripe invoice id
  amount_cents    integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void')),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz
);

-- ============================================================================
-- 13. Analytics rollups
-- ============================================================================

-- Dashboard 14-day series (invites/accepted/replies per day).
CREATE TABLE daily_stats (
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  linkedin_account_id uuid NOT NULL REFERENCES linkedin_accounts(id) ON DELETE CASCADE,
  day                 date NOT NULL,
  invites_sent        integer NOT NULL DEFAULT 0,
  emails_sent         integer NOT NULL DEFAULT 0,
  accepted            integer NOT NULL DEFAULT 0,
  replies             integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, linkedin_account_id, day)
);

-- "Best send times" heatmap (replies by weekday × hour).
CREATE TABLE hourly_stats (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day          date NOT NULL,
  hour         smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  sends        integer NOT NULL DEFAULT 0,
  replies      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, hour)
);

-- ============================================================================
-- 14. Derived stats — replaces the demo's campaignStats()
-- ============================================================================

CREATE VIEW campaign_stats AS
SELECT
  c.id AS campaign_id,
  c.workspace_id,
  count(DISTINCT e.lead_id)                                   AS leads,
  count(*) FILTER (WHERE j.status = 'sent')                   AS sent,
  CASE WHEN count(*) FILTER (WHERE j.status = 'sent') = 0 THEN 0
       ELSE round(100.0 * count(DISTINCT e.lead_id)
              FILTER (WHERE l.status IN ('accepted', 'replied'))
            / count(*) FILTER (WHERE j.status = 'sent'))
  END AS accepted_pct,
  CASE WHEN count(*) FILTER (WHERE j.status = 'sent') = 0 THEN 0
       ELSE round(100.0 * count(DISTINCT e.lead_id)
              FILTER (WHERE l.status = 'replied')
            / count(*) FILTER (WHERE j.status = 'sent'))
  END AS replied_pct
FROM campaigns c
LEFT JOIN enrollments e ON e.campaign_id = c.id
LEFT JOIN leads l       ON l.id = e.lead_id
LEFT JOIN jobs j        ON j.enrollment_id = e.id
GROUP BY c.id, c.workspace_id;

-- Template usage/accept stats (Sequences screen badges) — derived, not stored.
CREATE VIEW template_stats AS
SELECT
  t.id AS template_id,
  t.workspace_id,
  count(j.id) FILTER (WHERE j.status = 'sent') AS used,
  CASE WHEN count(j.id) FILTER (WHERE j.status = 'sent') = 0 THEN 0
       ELSE round(100.0 * count(DISTINCT j.lead_id)
              FILTER (WHERE l.status IN ('accepted', 'replied'))
            / count(j.id) FILTER (WHERE j.status = 'sent'))
  END AS accept_pct
FROM templates t
LEFT JOIN campaign_steps s ON s.template_id = t.id
LEFT JOIN jobs j           ON j.step_id = s.id
LEFT JOIN leads l          ON l.id = j.lead_id
GROUP BY t.id, t.workspace_id;

-- ============================================================================
-- 15. Row-Level Security — tenant isolation
-- The API sets `SET LOCAL app.workspace_id = '<uuid>'` per transaction.
-- ============================================================================

CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'invitations', 'api_keys', 'secrets', 'linkedin_accounts', 'email_accounts',
    'leads', 'blacklist', 'templates', 'campaigns', 'ab_tests', 'enrollments',
    'jobs', 'threads', 'integrations', 'webhook_endpoints', 'notifications',
    'activity', 'daily_stats', 'hourly_stats'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (workspace_id = current_workspace_id())
         WITH CHECK (workspace_id = current_workspace_id())', t);
  END LOOP;
END $$;

-- users / user_sessions / password_reset_tokens / oauth_identities / user_mfa
-- are identity-scoped (not tenant-scoped) — access them only via the auth
-- service role. messages, campaign_steps, ab_variants, webhook_deliveries,
-- subscriptions/invoices inherit isolation through their parent FK.

-- ============================================================================
-- 16. updated_at maintenance
-- ============================================================================

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER leads_touch     BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER campaigns_touch BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
