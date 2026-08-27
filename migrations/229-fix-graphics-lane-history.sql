-- Migration 229: fix graphics_lane_propagate_install() never writing history
--
-- Migration 092's trigger flips the matched graphics job to 'installed' and
-- then tries to log the change — but the history INSERT's SELECT runs AFTER
-- the UPDATE and filters `g.status <> 'installed'`, so on every successful
-- propagation it matches zero rows: the status change happened, the audit
-- trail didn't. (And even without the filter, g.status would have read the
-- NEW value as from_status.) The trigger is the ONLY writer of this history
-- for lane completions — the graphics-install-status route deliberately
-- relies on it — so installs never appeared in graphics job history.
--
-- Fix: capture the prior status first (FOR UPDATE, taking the same row lock
-- the UPDATE needs anyway), and only when an eligible row exists do the
-- update + history insert with the true from_status. The trigger itself is
-- unchanged — it references the function by name.

CREATE OR REPLACE FUNCTION graphics_lane_propagate_install() RETURNS TRIGGER AS $$
DECLARE
  prev_status TEXT;
BEGIN
  IF NEW.graphics_install_status = 'complete'
     AND (TG_OP = 'INSERT' OR OLD.graphics_install_status IS DISTINCT FROM 'complete')
     AND NEW.matched_graphics_job_id IS NOT NULL THEN
    SELECT status INTO prev_status
    FROM graphics_jobs
    WHERE id = NEW.matched_graphics_job_id
      AND status NOT IN ('installed', 'cancelled')
    FOR UPDATE;

    IF FOUND THEN
      UPDATE graphics_jobs
      SET status = 'installed',
          updated_at = NOW()
      WHERE id = NEW.matched_graphics_job_id;

      INSERT INTO graphics_status_history (job_id, from_status, to_status, changed_by, note)
      VALUES (NEW.matched_graphics_job_id, prev_status, 'installed',
              NEW.graphics_install_completed_by,
              'Vehicle install lane marked complete (VIN ' || COALESCE(NEW.vin, '?') || ')');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
