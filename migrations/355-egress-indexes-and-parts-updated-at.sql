-- Migration 355: support the cheap "did anything change?" checks that let
-- busy screens skip re-downloading whole tables (Supabase egress, 2026-10).
--
-- The PO screen now polls a fingerprint of the parts catalog (active count +
-- newest updated_at) instead of re-reading every part every 3 minutes. Most
-- writers already stamp updated_at by hand; the trigger makes it hold for
-- every write path. The indexes keep the "newest row" reads instant.

DROP TRIGGER IF EXISTS update_netsuite_parts_updated_at ON netsuite_parts;
CREATE TRIGGER update_netsuite_parts_updated_at
  BEFORE UPDATE ON netsuite_parts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE INDEX IF NOT EXISTS idx_netsuite_parts_updated_at ON netsuite_parts (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_graphics_jobs_updated_at ON graphics_jobs (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_graphics_job_views_last_viewed_at ON graphics_job_views (last_viewed_at DESC);
