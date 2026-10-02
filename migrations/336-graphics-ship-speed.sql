-- Migration 336: shipping speed on graphics production jobs.
--
-- Everything ships UPS; the person creating a Production job now picks how
-- fast (or that it is picked up / installed by BMG and not shipped at all),
-- so whoever packs it knows which service to buy. Nullable with no default:
-- older jobs and the other job types simply have no speed set.
ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS ship_speed TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'graphics_jobs_ship_speed_check'
  ) THEN
    ALTER TABLE graphics_jobs
      ADD CONSTRAINT graphics_jobs_ship_speed_check CHECK (
        ship_speed IS NULL OR ship_speed IN (
          'ups_ground', 'ups_3_day_select', 'ups_2nd_day_air', 'ups_next_day_air',
          'customer_pickup', 'bmg_delivered'
        )
      );
  END IF;
END $$;
