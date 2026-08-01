-- The dashboard's per-user "Recent activity" feed reads each user's own
-- rows newest-first via the attribution columns below. These tables only
-- had lookup indexes for their parent record (job_id, prospect_id, ...),
-- so the per-user read was a full-table scan. vehicle_status_history
-- (idx_vsh_changed_by) and estimates (idx_estimates_created_by) already
-- cover theirs.

CREATE INDEX IF NOT EXISTS idx_gsh_changed_by_created
  ON graphics_status_history(changed_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cni_jsh_changed_by_created
  ON cni_job_status_history(changed_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospect_activities_created_by
  ON prospect_activities(created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_by_at
  ON scan_logs(scanned_by, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_wrap_quotes_created_by_updated
  ON wrap_quotes(created_by, updated_at DESC);
