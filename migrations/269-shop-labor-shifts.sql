-- Migration 269: shop labor capture (R3-21 — owner decisions 2026-09-07:
-- job COSTING only, one blended rate, the time_entries punch clock stays
-- untouched).
--
-- work_shifts grows a third context: a 'shop' shift is a start/stop timer
-- on ONE check-in, run from the pick-list page by the crew working that
-- vehicle. Unlike cni/field shifts it NEVER writes install_credits — shop
-- techs are hourly employees paid through the punch-clock/payroll process;
-- these shifts exist so the margin report can price actual hours (member
-- presence overlap × the blended rate below) against the estimate's sold
-- labor line. Crew joins/leaves reuse work_shift_members; hours are pure
-- presence overlap (share_weight is a piece-rate concept and plays no part).

ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS fleet_checkin_id UUID REFERENCES fleet_checkins(id) ON DELETE CASCADE;
-- true = nobody pressed Stop: the shift was closed by vehicle completion or
-- the daily sweep. The margin report marks these hours as approximate.
ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_work_shifts_checkin ON work_shifts(fleet_checkin_id) WHERE fleet_checkin_id IS NOT NULL;

-- The 110-era CHECKs are inline and unnamed, and production was baselined
-- from a hand-migrated state — its auto-generated constraint names may not
-- match a fresh database's. Drop every CHECK on the table that references
-- context and re-add named replacements (idempotent: a re-run drops the
-- named trio and recreates it).
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
    CHECK (context IN ('cni', 'field', 'shop'));
  ALTER TABLE work_shifts ADD CONSTRAINT work_shifts_cni_needs_job
    CHECK (context <> 'cni' OR cni_job_id IS NOT NULL);
  ALTER TABLE work_shifts ADD CONSTRAINT work_shifts_shop_needs_checkin
    CHECK (context <> 'shop' OR fleet_checkin_id IS NOT NULL);
END $$;

-- The blended hourly COST of shop floor time (what an hour costs the
-- company — loaded wage, not the labor_rate estimates sell at). One number
-- by owner decision: no per-tech wages live in the app. NULL = the margin
-- report shows recorded hours but excludes labor from the margin math.
ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS shop_labor_cost_rate NUMERIC(10,2);

COMMENT ON COLUMN work_shifts.fleet_checkin_id IS
  'Migration 269: the check-in a shop-context shift timed (pick-list Start/Stop). NULL for cni/field shifts.';
COMMENT ON COLUMN work_shifts.auto_closed IS
  'Migration 269: closed by vehicle completion or the daily sweep rather than a Stop press — hours are approximate.';
COMMENT ON COLUMN quote_settings.shop_labor_cost_rate IS
  'Migration 269: blended hourly cost of shop labor for job costing (Settings → Shop Labor Cost Rate; super-admin write). NULL = margin shows hours only.';
