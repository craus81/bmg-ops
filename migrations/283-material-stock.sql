-- R6-2: material stock. The shop buys film, premask and ink by the roll or
-- cartridge and has never had a count of either — the roll plan could tell
-- you a job needs 38 linear feet of IJ280 while nobody could say whether
-- 38 feet existed in the building. Two tables: the stock instances, and
-- the reorder policy per material.
--
-- Ink honesty (owner question): with no printer API reachable from here,
-- ink is counted in CARTRIDGES ON HAND — received by hand, drawn down by
-- the printed-area estimate — not measured in ml. The unit column keeps
-- that distinction explicit rather than pretending feet and cartridges are
-- the same number.

CREATE TABLE IF NOT EXISTS material_rolls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Catalog link when the material is a known film; the name is stored
  -- either way so history survives a catalog edit.
  substrate_id UUID REFERENCES wrap_substrates(id) ON DELETE SET NULL,
  material_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'film' CHECK (kind IN ('film', 'premask', 'ink')),
  unit TEXT NOT NULL DEFAULT 'ft' CHECK (unit IN ('ft', 'cartridge')),
  width_in NUMERIC(6,2) CHECK (width_in IS NULL OR (width_in > 0 AND width_in <= 200)),
  initial_qty NUMERIC(10,2) NOT NULL CHECK (initial_qty > 0),
  remaining_qty NUMERIC(10,2) NOT NULL CHECK (remaining_qty >= 0),
  cost NUMERIC(10,2) CHECK (cost IS NULL OR cost >= 0),
  vendor_name TEXT,
  -- Where it came from, when it was received against a mirrored PO line.
  po_line_id UUID,
  received_at DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'depleted', 'scrapped')),
  notes TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (remaining_qty <= initial_qty)
);

CREATE INDEX IF NOT EXISTS idx_material_rolls_open
  ON material_rolls(kind, material_name, received_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_material_rolls_substrate
  ON material_rolls(substrate_id) WHERE substrate_id IS NOT NULL;

ALTER TABLE material_rolls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff manage material rolls" ON material_rolls;
CREATE POLICY "Staff manage material rolls" ON material_rolls
  FOR ALL TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());

-- Reorder policy per MATERIAL (not per roll). material_key is the
-- normalized name, the same casing/spacing rule the film matcher uses, so
-- "IJ280" and "ij280 " are one policy.
CREATE TABLE IF NOT EXISTS material_stock_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL DEFAULT 'film' CHECK (kind IN ('film', 'premask', 'ink')),
  material_key TEXT NOT NULL,
  material_name TEXT NOT NULL,
  substrate_id UUID REFERENCES wrap_substrates(id) ON DELETE SET NULL,
  unit TEXT NOT NULL DEFAULT 'ft' CHECK (unit IN ('ft', 'cartridge')),
  -- Below reorder_at, the nightly sweep raises a purchase request for
  -- enough to reach order_up_to. NULL reorder_at = watched but never
  -- auto-ordered, matching the parts reorder-point semantics (m271).
  reorder_at NUMERIC(10,2) CHECK (reorder_at IS NULL OR reorder_at >= 0),
  order_up_to NUMERIC(10,2) CHECK (order_up_to IS NULL OR order_up_to >= 0),
  vendor_name TEXT,
  -- The NetSuite item the raised request should order, when there is one.
  item_number TEXT,
  updated_by UUID REFERENCES profiles(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, material_key)
);

ALTER TABLE material_stock_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff read material stock settings" ON material_stock_settings;
CREATE POLICY "Staff read material stock settings" ON material_stock_settings
  FOR SELECT TO authenticated USING (public.is_internal_staff());
-- Writes go through the admin API (service role) only.

-- A logged material line can name the roll it came off, so a decrement is
-- traceable back to the job that caused it.
ALTER TABLE graphics_job_materials ADD COLUMN IF NOT EXISTS roll_id UUID REFERENCES material_rolls(id) ON DELETE SET NULL;

COMMENT ON COLUMN material_rolls.remaining_qty IS
  'Feet left on the roll (or cartridges on hand for ink). Drawn down by "Log material from plan"; a roll reaching 0 flips status to depleted.';
