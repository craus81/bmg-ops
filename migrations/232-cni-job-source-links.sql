-- Migration 232: graphics/check-in → CNI job bridge provenance
--
-- The audit's MAJOR finding: outsourcing an install meant re-typing the
-- whole job into /admin/cni/jobs/new and losing the pay/photo/billing
-- machinery. The bridge prefills that form from a graphics job or a fleet
-- check-in; these columns record where a job came from, power the
-- source ⇄ job panels on both sides, and make creation idempotent.
--
-- The partial unique indexes are the find-or-create guard: each graphics
-- job / check-in spawns at most ONE CNI job, enforced by the DB so even a
-- double-click race resolves to a single job (the losing insert gets 23505
-- and the client redirects to the winner).
--
-- ON DELETE SET NULL: a deleted source never takes the CNI job with it.
--
-- cni_job_vins.checkin_id records which check-in seeded a VIN row, so the
-- bridge can't re-seed the same vehicle and the round trip stays traceable.
--
-- No RLS changes: staff CRUD on cni_jobs/cni_job_vins already covers the
-- new columns, and installers only SELECT.

ALTER TABLE cni_jobs
  ADD COLUMN IF NOT EXISTS source_graphics_job_id UUID REFERENCES graphics_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_checkin_id UUID REFERENCES fleet_checkins(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cni_jobs_source_graphics_job
  ON cni_jobs(source_graphics_job_id) WHERE source_graphics_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cni_jobs_source_checkin
  ON cni_jobs(source_checkin_id) WHERE source_checkin_id IS NOT NULL;

ALTER TABLE cni_job_vins
  ADD COLUMN IF NOT EXISTS checkin_id UUID REFERENCES fleet_checkins(id) ON DELETE SET NULL;

COMMENT ON COLUMN cni_jobs.source_graphics_job_id IS
  'Bridge provenance: the graphics job this CNI job was created from (partial unique index = one CNI job per source).';
COMMENT ON COLUMN cni_jobs.source_checkin_id IS
  'Bridge provenance: the fleet check-in this CNI job was created from (partial unique index = one CNI job per source).';
COMMENT ON COLUMN cni_job_vins.checkin_id IS
  'Bridge provenance: the fleet check-in that seeded this VIN row.';
