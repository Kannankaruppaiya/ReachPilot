-- Associate each lead with the scrape run that first found it, so the Leads
-- screen can show a single run's results (like a saved search / list in Apollo,
-- Clay, Instantly). Set on INSERT only; a later run that re-surfaces an existing
-- profile does NOT overwrite it (dedup upsert keeps the original finder), so a
-- run's list == the NEW leads that run contributed.
alter table leads add column if not exists scrape_job_id uuid;

create index if not exists leads_by_scrape_job
  on leads (workspace_id, scrape_job_id)
  where scrape_job_id is not null;
