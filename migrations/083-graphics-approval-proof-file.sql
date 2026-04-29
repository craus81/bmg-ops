-- Migration 083: Per-send proof file selection on graphics_jobs
--
-- The "Send for approval" flow used to expose every row in
-- graphics_job_files for the customer to see. Most jobs have multiple
-- working files (concept artwork, mockups, internal references) and
-- only one is the actual proof being approved. Add a column that
-- records which file was chosen at send-time so the public approval
-- page can render just that one.
--
-- Nullable: legacy rows (and any future caller that wants the old
-- "show all files" behaviour) will leave it null and the approval
-- page falls back to the all-files view.

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS approval_proof_file_id UUID
    REFERENCES graphics_job_files(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_graphics_jobs_approval_proof_file
  ON graphics_jobs(approval_proof_file_id)
  WHERE approval_proof_file_id IS NOT NULL;

COMMENT ON COLUMN graphics_jobs.approval_proof_file_id
  IS 'graphics_job_files.id chosen at send-for-approval time. The public approval page filters to this one file when set.';
