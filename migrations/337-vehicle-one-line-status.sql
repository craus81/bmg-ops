-- Migration 337: one-line vehicle status (owner layout 2026-10-02).
--
-- The vehicle Update Status row and the separate Graphics Install row become
-- one line: Received, Graphics, Graphics Complete, In Progress Upfit, Upfit
-- Complete, Complete, Shipped — in any order. fleet_checkins.status keeps
-- its real values (received / in_progress / complete / shipped) so every
-- report, alert and dashboard reads it as before; while in_progress,
-- shop_stage says which of the four middle buttons is current.
--
-- Graphics Complete stays checked through graphics_install_status =
-- 'complete' (migration 085). Upfit Complete needs its own stamp, which
-- stays set when the status moves on.
--
-- Shop job timers record which crew they bill, so Graphics and Upfit hours
-- split (null = an older timer, counted as upfit).
--
-- Stuck (Parts) and Stuck (Graphics) are retired: vehicles holding them
-- move to In Progress (Graphics for stuck-on-graphics, Upfit otherwise),
-- and vehicles already in_progress get Upfit (or Graphics when their
-- graphics install lane is the one running).
ALTER TABLE fleet_checkins
  ADD COLUMN IF NOT EXISTS shop_stage TEXT,
  ADD COLUMN IF NOT EXISTS upfit_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS upfit_completed_by UUID REFERENCES auth.users(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fleet_checkins_shop_stage_check'
  ) THEN
    ALTER TABLE fleet_checkins
      ADD CONSTRAINT fleet_checkins_shop_stage_check CHECK (
        shop_stage IS NULL OR shop_stage IN ('graphics', 'graphics_complete', 'upfit', 'upfit_complete')
      );
  END IF;
END $$;

ALTER TABLE work_shifts
  ADD COLUMN IF NOT EXISTS shop_stage TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_shifts_shop_stage_check'
  ) THEN
    ALTER TABLE work_shifts
      ADD CONSTRAINT work_shifts_shop_stage_check CHECK (
        shop_stage IS NULL OR shop_stage IN ('graphics', 'upfit')
      );
  END IF;
END $$;

UPDATE fleet_checkins
   SET shop_stage = CASE WHEN status = 'stuck_graphics' THEN 'graphics' ELSE 'upfit' END,
       status = 'in_progress'
 WHERE status IN ('stuck_parts', 'stuck_graphics');

UPDATE fleet_checkins
   SET shop_stage = CASE WHEN graphics_install_status = 'in_progress' THEN 'graphics' ELSE 'upfit' END
 WHERE status = 'in_progress'
   AND shop_stage IS NULL;

-- The graphics install lane's own Stuck goes too.
UPDATE fleet_checkins
   SET graphics_install_status = 'in_progress'
 WHERE graphics_install_status = 'stuck';
