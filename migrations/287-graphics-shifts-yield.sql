-- R6-6, the materials chain remainder. Two independent pieces that both
-- hang off work the graphics job page already does.
--
-- 1. PRINT-ROOM TIMERS. work_shifts gains a fourth context, 'graphics',
--    tied to a graphics job the way 'shop' is tied to a check-in (m269).
--    Same rules as shop: costing only — never a rate, never install
--    credits, hours are pure crew-presence overlap, and the daily sweep
--    closes runaways.
--
-- 2. MATERIAL YIELD. The roll plan already computes graphic area beside
--    roll area; only the roll half was ever stored. Persisting the graphic
--    half makes waste and utilization answerable per film without
--    re-deriving every saved plan.

ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS graphics_job_id UUID REFERENCES graphics_jobs(id) ON DELETE CASCADE;
-- Optional sub-task on a print-room shift: print / cut / laminate / design.
ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS task_tag TEXT
  CHECK (task_tag IS NULL OR task_tag IN ('print', 'cut', 'laminate', 'design', 'other'));

CREATE INDEX IF NOT EXISTS idx_work_shifts_graphics_job
  ON work_shifts(graphics_job_id) WHERE graphics_job_id IS NOT NULL;

-- Rebuild the context CHECK trio the same idempotent way m269 did: the
-- constraint names differ between a fresh database and the hand-migrated
-- production baseline, so drop every context CHECK and re-add named ones.
DO $$
DECLARE con RECORD;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'work_shifts'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%context%'
  LOOP
    EXECUTE format('ALTER TABLE work_shifts DROP CONSTRAINT %I', con.conname);
  END LOOP;
  ALTER TABLE work_shifts ADD CONSTRAINT work_shifts_context_valid
    CHECK (context IN ('cni', 'field', 'shop', 'graphics'));
  ALTER TABLE work_shifts ADD CONSTRAINT work_shifts_cni_needs_job
    CHECK (context <> 'cni' OR cni_job_id IS NOT NULL);
  ALTER TABLE work_shifts ADD CONSTRAINT work_shifts_shop_needs_checkin
    CHECK (context <> 'shop' OR fleet_checkin_id IS NOT NULL);
  ALTER TABLE work_shifts ADD CONSTRAINT work_shifts_graphics_needs_job
    CHECK (context <> 'graphics' OR graphics_job_id IS NOT NULL);
END $$;

COMMENT ON COLUMN work_shifts.graphics_job_id IS
  'R6-6: the graphics job a print-room shift timed (job-page Start/Stop). NULL for every other context.';

-- Printed area for a logged material line. quantity_sqft is the ROLL area
-- consumed; this is the area the graphic actually occupied, so waste is
-- the difference and utilization is the ratio. NULL where a line predates
-- the roll plan or was typed by hand — the report says so rather than
-- reporting 100% waste.
ALTER TABLE graphics_job_materials ADD COLUMN IF NOT EXISTS graphic_sqft NUMERIC(10,2)
  CHECK (graphic_sqft IS NULL OR graphic_sqft >= 0);

COMMENT ON COLUMN graphics_job_materials.graphic_sqft IS
  'R6-6: printed graphic area for this line. quantity_sqft − graphic_sqft = waste. NULL = unknown (hand-typed or pre-roll-plan), never assumed zero.';
