-- R5-16: shop crew capacity — the denominator for the week planner's load
-- bars. Base capacity = crew size × shift hours (quote_settings singleton,
-- the same settings row the margin floor and labor rate live on); one-off
-- days (holiday, short crew) get a per-day hours override.

ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS shop_crew_size INTEGER
  CHECK (shop_crew_size IS NULL OR (shop_crew_size >= 0 AND shop_crew_size <= 200));
ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS shop_shift_hours NUMERIC(4,1)
  CHECK (shop_shift_hours IS NULL OR (shop_shift_hours >= 0 AND shop_shift_hours <= 24));

COMMENT ON COLUMN quote_settings.shop_crew_size IS
  'Installers on the floor on a normal day — capacity = crew × shift hours (R5-16 week planner). NULL = capacity not configured; the planner shows demand without judging it.';

CREATE TABLE IF NOT EXISTS shop_capacity_overrides (
  day DATE PRIMARY KEY,
  hours NUMERIC(6,1) NOT NULL CHECK (hours >= 0 AND hours <= 2000),
  note TEXT,
  updated_by UUID REFERENCES profiles(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE shop_capacity_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff read capacity overrides" ON shop_capacity_overrides;
CREATE POLICY "Staff read capacity overrides" ON shop_capacity_overrides
  FOR SELECT TO authenticated USING (public.is_internal_staff());
-- Writes go through the admin API (service role) only.
