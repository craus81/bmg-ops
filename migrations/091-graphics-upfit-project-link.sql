-- Migration 084: Link graphics jobs to their parent upfit project
--
-- Today graphics_jobs and upfit_projects only meet indirectly:
--   * via a shared estimate (graphics_jobs.estimate_id = upfit_projects.estimate_id)
--   * via a shared fleet check-in (fleet_checkins.matched_graphics_job_id +
--     upfit_projects.fleet_checkin_id)
--
-- This migration adds a direct nullable FK so the upfit project page can show
-- its graphics work, the graphics page can show its parent upfit, and the
-- /tracking install view can render a graphics lane alongside the upfit lane.
-- Standalone graphics jobs (no associated upfit) simply leave the column null.

-- ═══════════ COLUMN + INDEX ═══════════

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS upfit_project_id UUID REFERENCES upfit_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_graphics_jobs_upfit_project
  ON graphics_jobs(upfit_project_id);

-- ═══════════ BACKFILL ═══════════
-- Each pass only fills rows still NULL, in confidence order.

-- Pass 1: shared estimate_id (highest confidence — both rows already point at
-- the same estimate, the dominant linkage in the existing codebase).
UPDATE graphics_jobs g
SET upfit_project_id = p.id
FROM upfit_projects p
WHERE g.upfit_project_id IS NULL
  AND g.estimate_id IS NOT NULL
  AND p.estimate_id = g.estimate_id;

-- Pass 2: shared fleet check-in. graphics_jobs.id is referenced by
-- fleet_checkins.matched_graphics_job_id (migration 047); upfit_projects
-- already point at the same fleet_checkin via fleet_checkin_id (migration 073
-- + auto-link trigger in 078).
UPDATE graphics_jobs g
SET upfit_project_id = p.id
FROM fleet_checkins fc
JOIN upfit_projects p ON p.fleet_checkin_id = fc.id
WHERE g.upfit_project_id IS NULL
  AND fc.matched_graphics_job_id = g.id;

-- Pass 3: shared SO number. graphics_jobs don't carry the SO directly, but a
-- linked PO often was issued against the same SO that produced the upfit
-- project. Reach upfit_projects through fleet_checkins by sales_order_number
-- when both rows were created without a shared estimate (e.g. PO-first jobs).
UPDATE graphics_jobs g
SET upfit_project_id = p.id
FROM fleet_checkins fc
JOIN upfit_projects p
  ON (fc.netsuite_sales_order_id IS NOT NULL AND p.netsuite_so_id = fc.netsuite_sales_order_id)
  OR (fc.sales_order_number IS NOT NULL AND p.netsuite_so_number = fc.sales_order_number)
WHERE g.upfit_project_id IS NULL
  AND fc.matched_graphics_job_id = g.id;

-- ═══════════ FORWARD-LINK TRIGGERS ═══════════
-- Keep upfit_project_id maintained when either side gets (or changes) its
-- estimate_id, so app code never has to remember to set both pointers.
-- Mirrors the handoff pattern established in migration 078.

CREATE OR REPLACE FUNCTION graphics_link_upfit_on_estimate() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.estimate_id IS NOT NULL
     AND NEW.upfit_project_id IS NULL
     AND (TG_OP = 'INSERT' OR NEW.estimate_id IS DISTINCT FROM OLD.estimate_id) THEN
    SELECT id INTO NEW.upfit_project_id
    FROM upfit_projects
    WHERE estimate_id = NEW.estimate_id
    ORDER BY updated_at DESC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS graphics_jobs_link_upfit ON graphics_jobs;
CREATE TRIGGER graphics_jobs_link_upfit
  BEFORE INSERT OR UPDATE OF estimate_id ON graphics_jobs
  FOR EACH ROW EXECUTE FUNCTION graphics_link_upfit_on_estimate();


CREATE OR REPLACE FUNCTION upfit_link_graphics_on_estimate() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.estimate_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.estimate_id IS DISTINCT FROM OLD.estimate_id) THEN
    UPDATE graphics_jobs
    SET upfit_project_id = NEW.id,
        updated_at = NOW()
    WHERE estimate_id = NEW.estimate_id
      AND upfit_project_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS upfit_projects_link_graphics ON upfit_projects;
CREATE TRIGGER upfit_projects_link_graphics
  AFTER INSERT OR UPDATE OF estimate_id ON upfit_projects
  FOR EACH ROW EXECUTE FUNCTION upfit_link_graphics_on_estimate();

-- Also link via the fleet check-in handoff: when fleet_checkins.matched_graphics_job_id
-- is set on a check-in that already maps to an upfit_project, propagate that
-- to the graphics job.
CREATE OR REPLACE FUNCTION graphics_link_upfit_on_checkin_match() RETURNS TRIGGER AS $$
DECLARE
  matched_project UUID;
BEGIN
  IF NEW.matched_graphics_job_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.matched_graphics_job_id IS DISTINCT FROM OLD.matched_graphics_job_id) THEN
    SELECT id INTO matched_project
    FROM upfit_projects
    WHERE fleet_checkin_id = NEW.id
    ORDER BY updated_at DESC
    LIMIT 1;

    IF matched_project IS NOT NULL THEN
      UPDATE graphics_jobs
      SET upfit_project_id = matched_project,
          updated_at = NOW()
      WHERE id = NEW.matched_graphics_job_id
        AND upfit_project_id IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fleet_checkin_link_graphics_to_upfit ON fleet_checkins;
CREATE TRIGGER fleet_checkin_link_graphics_to_upfit
  AFTER INSERT OR UPDATE OF matched_graphics_job_id ON fleet_checkins
  FOR EACH ROW EXECUTE FUNCTION graphics_link_upfit_on_checkin_match();
