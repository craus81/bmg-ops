-- Migration 228: release part reservations whenever an upfit project ends
--
-- part_allocations rows (status 'reserved') were only flipped by the
-- /api/upfit-projects PUT handler — but the migration-085 trigger
-- upfit_complete_on_ship() marks the linked project 'completed' directly in
-- the database when its vehicle ships, bypassing that route entirely (085
-- predates the allocations table, 164). Every project completed via shipping
-- therefore stranded its reservations in 'reserved' forever, inflating
-- "allocated" and deflating "free" on the inventory screen and the parts
-- readiness math.
--
-- Fix at the source of truth: an AFTER UPDATE trigger on upfit_projects
-- itself, so the flip happens no matter who changes the status (the 085
-- ship trigger, the API route, or any future writer — Postgres row triggers
-- fire for updates made inside other trigger functions, so the
-- fleet_checkins → upfit_projects chain reaches this). Semantics copied from
-- the route handler: completed → consumed, cancelled → released, and only
-- rows still 'reserved' are touched, so the route's own (now redundant)
-- flip double-firing is a no-op.
--
-- Plus a backfill for the rows already stranded on terminal projects.
-- Idempotent; runs inside the migrate.mjs per-file transaction.

CREATE OR REPLACE FUNCTION public.upfit_allocations_on_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('completed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE part_allocations
    SET status = CASE WHEN NEW.status = 'completed' THEN 'consumed' ELSE 'released' END,
        released_at = NOW(),
        updated_at = NOW()
    WHERE project_id = NEW.id AND status = 'reserved';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

DROP TRIGGER IF EXISTS trg_upfit_allocations_on_status ON upfit_projects;
CREATE TRIGGER trg_upfit_allocations_on_status
  AFTER UPDATE OF status ON upfit_projects
  FOR EACH ROW
  EXECUTE FUNCTION public.upfit_allocations_on_status();

-- Backfill: reservations stranded on projects that already ended.
UPDATE part_allocations pa
SET status = CASE WHEN up.status = 'completed' THEN 'consumed' ELSE 'released' END,
    released_at = NOW(),
    updated_at = NOW()
FROM upfit_projects up
WHERE pa.project_id = up.id
  AND pa.status = 'reserved'
  AND up.status IN ('completed', 'cancelled');
