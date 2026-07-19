-- Upfit hub phase 1: the dates that make an upfit project trackable, an
-- install-location on graphics jobs, and a shop_inbound table — one row per
-- vehicle expected at the shop — that the Shop Board reads.

-- ── Upfit project key dates ──────────────────────────────────────────────
ALTER TABLE upfit_projects ADD COLUMN IF NOT EXISTS parts_ordered_date DATE;
ALTER TABLE upfit_projects ADD COLUMN IF NOT EXISTS parts_eta DATE;
ALTER TABLE upfit_projects ADD COLUMN IF NOT EXISTS customer_dropoff_date DATE;
ALTER TABLE upfit_projects ADD COLUMN IF NOT EXISTS need_back_date DATE;

-- ── Where the graphics get installed ─────────────────────────────────────
-- Pick-list in the UI ("O'Fallon Shop" routes the job into the shop
-- schedule); TEXT here so adding a location never needs a migration.
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS install_location TEXT;

-- ── Inbound vehicles: what's headed to the shop ──────────────────────────
-- Auto-maintained from graphics jobs (install at our shop) and upfit
-- projects (customer drop-off date set); manual rows allowed for walk-ins.
-- source_id defaults to a random UUID so (source_type, source_id) stays
-- unique for manual rows too.
CREATE TABLE IF NOT EXISTS shop_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('graphics_job', 'upfit_project', 'manual')),
  source_id UUID NOT NULL DEFAULT gen_random_uuid(),
  vehicle_desc TEXT,
  customer_name TEXT,
  work_summary TEXT,
  install_location TEXT,
  expected_date DATE,
  need_back_date DATE,
  status TEXT NOT NULL DEFAULT 'expected'
    CHECK (status IN ('expected', 'arrived', 'cancelled')),
  fleet_checkin_id UUID,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_shop_inbound_status
  ON shop_inbound(status, expected_date);

ALTER TABLE shop_inbound ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff manage shop inbound' AND tablename = 'shop_inbound') THEN
    CREATE POLICY "Staff manage shop inbound" ON shop_inbound
      FOR ALL TO authenticated
      USING (public.is_internal_staff())
      WITH CHECK (public.is_internal_staff());
  END IF;
END $$;
