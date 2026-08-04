-- ============================================================================
-- 0006: Lead engine — scale + diversity
--
-- Prepares leads for LARGE, DIVERSE scraped volumes:
--   * subdomain-agnostic dedup (in.linkedin.com vs www.linkedin.com were treated
--     as different under the old lower(linkedin_url) index → duplicate people)
--   * ranking + free-email-enrichment columns (fit_score, email_confidence,
--     email_pattern)
--   * listing indexes for recency pagination + source filtering
--   * scrape_jobs — per-run visibility (status / counts / reason)
--
-- The leads table is small today, so the one-off backfill + dedup live with the
-- DDL here. On a large table the dedup DELETE and the unique index would be split
-- into a separate data migration and the index built CONCURRENTLY (see the
-- database-migrations guidance).
-- ============================================================================

-- 1. Additive columns — nullable, so instant with no table rewrite. ------------
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS linkedin_slug    text,
  ADD COLUMN IF NOT EXISTS fit_score        smallint,
  ADD COLUMN IF NOT EXISTS email_confidence smallint,
  ADD COLUMN IF NOT EXISTS email_pattern    text;

-- 2. Backfill the canonical /in/<slug> handle (subdomain-agnostic, lowercased). -
UPDATE leads
   SET linkedin_slug = lower(substring(linkedin_url from 'linkedin\.com/in/([^/?#]+)'))
 WHERE linkedin_url IS NOT NULL AND linkedin_slug IS NULL;

-- 3. Collapse any pre-existing in./www. duplicates (keep the newest) so the
--    unique index below can be created. ctid breaks created_at ties.
DELETE FROM leads a USING leads b
 WHERE a.workspace_id = b.workspace_id
   AND a.linkedin_slug = b.linkedin_slug
   AND a.linkedin_slug IS NOT NULL
   AND (a.created_at < b.created_at
        OR (a.created_at = b.created_at AND a.ctid < b.ctid));

-- 4. Replace the raw-URL dedup index with a subdomain-agnostic slug index. ------
DROP INDEX IF EXISTS leads_dedup_linkedin;
CREATE UNIQUE INDEX IF NOT EXISTS leads_dedup_slug
  ON leads (workspace_id, linkedin_slug) WHERE linkedin_slug IS NOT NULL;

-- 5. Listing indexes for large tables. -----------------------------------------
CREATE INDEX IF NOT EXISTS leads_by_created ON leads (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_by_source  ON leads (workspace_id, source);

-- 6. Scrape-job visibility. ----------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  titles       jsonb NOT NULL DEFAULT '[]',
  location     text,
  max_results  int  NOT NULL DEFAULT 15,
  status       text NOT NULL DEFAULT 'queued',   -- queued|running|done|blocked|failed
  stage        text,
  counts       jsonb NOT NULL DEFAULT '{}',       -- {raw,candidates,valid,imported}
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scrape_jobs_ws_created ON scrape_jobs (workspace_id, created_at DESC);

ALTER TABLE scrape_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrape_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON scrape_jobs;
CREATE POLICY tenant_isolation ON scrape_jobs
  USING (workspace_id = current_workspace_id());
