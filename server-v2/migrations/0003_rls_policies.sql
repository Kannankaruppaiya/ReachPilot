-- ============================================================================
-- 0003: Force RLS on all workspace-scoped tables + add missing policies
--
-- The schema already has ENABLE ROW LEVEL SECURITY and tenant_isolation
-- policies on most tables, but FORCE is not set (so superusers bypass RLS).
-- This migration:
--   1. Sets FORCE ROW LEVEL SECURITY so even our superuser connection obeys RLS
--   2. Adds missing policies on tables the original schema didn't cover
-- ============================================================================

-- Force RLS on already-enabled tables
ALTER TABLE ab_tests FORCE ROW LEVEL SECURITY;
ALTER TABLE activity FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE blacklist FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE daily_stats FORCE ROW LEVEL SECURITY;
ALTER TABLE email_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE hourly_stats FORCE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
ALTER TABLE linkedin_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;

-- Enable + Force RLS on tables that were missing policies
-- memberships
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (workspace_id = current_workspace_id());


-- subscriptions
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions
  USING (workspace_id = current_workspace_id());



-- audit_log (workspace_id nullable — allow system rows)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (workspace_id = current_workspace_id() OR workspace_id IS NULL);

-- campaign_stats is a VIEW — RLS not applicable
-- template_stats is a VIEW — RLS not applicable
