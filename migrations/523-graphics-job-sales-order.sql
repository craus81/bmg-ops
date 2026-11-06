-- Migration 523: a graphics job made from (or linked to) a sales order.
--
-- Craig, 2026-11-06 (thread "Create graphics jobs from sales orders", picked
-- 1C 2A 3A): the sales order page gets a Graphics card with "+ Create
-- graphics job", and it works for orders typed straight into NetSuite too,
-- which have no FleetSuite estimate to hang the job on. This column is that
-- link; jobs from an estimate-backed order carry it beside estimate_id.

ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS netsuite_so_id TEXT;

CREATE INDEX IF NOT EXISTS graphics_jobs_netsuite_so_id_idx
  ON graphics_jobs (netsuite_so_id) WHERE netsuite_so_id IS NOT NULL;

COMMENT ON COLUMN graphics_jobs.netsuite_so_id IS
  'NetSuite internal id of the sales order this job was made from or linked to (migration 523). Shown on the sales order page''s Graphics card and counted by the job progress bar.';
