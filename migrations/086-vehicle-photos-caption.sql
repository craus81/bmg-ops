-- Migration 086: T1.4 Unified photo timeline
--
-- Adds an optional caption column to vehicle_photos so installers can annotate
-- a photo at upload time — valuable for dispute protection (e.g. "pre-existing
-- dent on left bumper") and general context. No other schema changes are
-- required for the unified timeline: it joins existing vehicle_photos,
-- graphics_proofs via vehicle_proofs, and graphics_job_files via the matched
-- graphics job.

ALTER TABLE vehicle_photos
  ADD COLUMN IF NOT EXISTS caption TEXT;

COMMENT ON COLUMN vehicle_photos.caption IS
  'Optional short caption entered by the uploader. Used by the unified photo timeline (T1.4) for context.';
