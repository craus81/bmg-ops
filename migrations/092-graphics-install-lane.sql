-- Migration 085: Graphics install lane on fleet_checkins
--
-- Step 4 of unifying upfit + graphics workflows. The /tracking detail view
-- now needs a parallel "graphics install" lane independent of the upfit lane
-- (no forced ordering). The lane lives on fleet_checkins so it stays
-- per-vehicle — a single graphics_job that ships across N vans should track
-- install progress separately for each van.
--
-- The upfit lane continues to live in fleet_checkins.status with
-- 'received' → 'in_progress' → 'stuck_parts' → 'complete' → 'shipped'.
-- The graphics lane lives in graphics_install_status with
-- 'pending' → 'in_progress' → 'stuck' → 'complete' (plus 'n/a' for
-- vehicles that don't get graphics).
--
-- Completion ceremony (fleet_checkins.status: in_progress → complete) is
-- gated in the API to also require graphics_install_status IN
-- ('complete', 'n/a') when a graphics job is linked.

ALTER TABLE fleet_checkins
  ADD COLUMN IF NOT EXISTS graphics_install_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (graphics_install_status IN ('pending', 'in_progress', 'stuck', 'complete', 'n/a')),
  ADD COLUMN IF NOT EXISTS graphics_install_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS graphics_install_completed_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS graphics_install_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_fleet_checkins_graphics_install_status
  ON fleet_checkins(graphics_install_status)
  WHERE graphics_install_status NOT IN ('pending', 'n/a');

-- ═══════════ BACKFILL ═══════════
-- Vehicles with no graphics linkage at all → 'n/a' so the lane UI hides
-- and the completion gate doesn't block. Reach the upfit_project linkage
-- via migration 084 in case matched_graphics_job_id is null but the vehicle
-- still has graphics through the project graph.
UPDATE fleet_checkins fc
SET graphics_install_status = 'n/a'
WHERE fc.matched_graphics_job_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM upfit_projects p
    JOIN graphics_jobs g ON g.upfit_project_id = p.id
    WHERE p.fleet_checkin_id = fc.id
  );

-- Vehicles whose matched graphics job is already 'installed' or 'shipped'
-- → lane is already complete. Reflect that so historic check-ins don't
-- show as "graphics still pending" forever.
UPDATE fleet_checkins fc
SET graphics_install_status = 'complete',
    graphics_install_completed_at = COALESCE(
      (SELECT updated_at FROM graphics_jobs WHERE id = fc.matched_graphics_job_id),
      NOW()
    )
WHERE fc.matched_graphics_job_id IS NOT NULL
  AND graphics_install_status = 'pending'
  AND EXISTS (
    SELECT 1 FROM graphics_jobs g
    WHERE g.id = fc.matched_graphics_job_id AND g.status = 'installed'
  );

-- ═══════════ FORWARD TRIGGER ═══════════
-- When the lane is marked complete, propagate to the matched graphics job's
-- production status so the graphics page reflects the install outcome
-- without manual double-entry. One-way: nothing here updates the lane in
-- response to graphics_jobs changes — the install lane is per-vehicle and
-- shouldn't get clobbered by production-side state changes.
CREATE OR REPLACE FUNCTION graphics_lane_propagate_install() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.graphics_install_status = 'complete'
     AND (TG_OP = 'INSERT' OR OLD.graphics_install_status IS DISTINCT FROM 'complete')
     AND NEW.matched_graphics_job_id IS NOT NULL THEN
    UPDATE graphics_jobs
    SET status = 'installed',
        updated_at = NOW()
    WHERE id = NEW.matched_graphics_job_id
      AND status NOT IN ('installed', 'cancelled');

    INSERT INTO graphics_status_history (job_id, from_status, to_status, changed_by, note)
    SELECT NEW.matched_graphics_job_id, g.status, 'installed', NEW.graphics_install_completed_by,
           'Vehicle install lane marked complete (VIN ' || COALESCE(NEW.vin, '?') || ')'
    FROM graphics_jobs g
    WHERE g.id = NEW.matched_graphics_job_id
      AND g.status <> 'installed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fleet_checkin_graphics_lane_complete ON fleet_checkins;
CREATE TRIGGER fleet_checkin_graphics_lane_complete
  AFTER INSERT OR UPDATE OF graphics_install_status ON fleet_checkins
  FOR EACH ROW EXECUTE FUNCTION graphics_lane_propagate_install();
