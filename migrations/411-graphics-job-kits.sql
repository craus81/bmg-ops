-- One graphics job for a fleet order (Craig, 2026-10-19). The estimates of
-- a fleet order (migration 410) share one graphics job: identical kits
-- that differ only by unit number. Design, proof and printing happen once;
-- the vehicles can arrive weeks apart, so each kit is installed on its own.
--
-- graphics_jobs.fleet_group_id: the fleet order the job makes kits for.
-- Its kits are that order's estimates, read live, so a vehicle added to
-- the order later gets a kit with nothing stored here.
--
-- graphics_job_kits: one row per kit once it's installed (no row = not
-- installed yet). Written by /api/graphics-jobs/[id]/kits with the service
-- role; no client reads, so RLS on with no policies.

ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS fleet_group_id UUID;

CREATE INDEX IF NOT EXISTS graphics_jobs_fleet_group_id_idx
  ON graphics_jobs (fleet_group_id)
  WHERE fleet_group_id IS NOT NULL;

COMMENT ON COLUMN graphics_jobs.fleet_group_id IS
  'Fleet order (estimates.fleet_group_id) this job makes one kit per vehicle for. NULL = an ordinary job.';

CREATE TABLE IF NOT EXISTS graphics_job_kits (
  job_id UUID NOT NULL REFERENCES graphics_jobs(id) ON DELETE CASCADE,
  estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by UUID REFERENCES auth.users(id),
  PRIMARY KEY (job_id, estimate_id)
);

ALTER TABLE graphics_job_kits ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE graphics_job_kits IS
  'Installed kits of a fleet order graphics job: one row per vehicle whose kit is on. See migration 411.';
