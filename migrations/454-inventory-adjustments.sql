-- Inventory Adjust button (Craig 2026-10-30, thread "Build an inventory adjust button").
--
-- Admins correct a part's stock at O'Fallon from the Inventory page or the
-- part's details; FleetSuite posts a NetSuite Inventory Adjustment (52000
-- Inventory Adjustment) and keeps this history of who did it and why. The
-- on-hand numbers themselves stay NetSuite's (netsuite_parts copy).
-- Writes go through /api/inventory/adjust's service client.

CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id UUID REFERENCES netsuite_parts(id) ON DELETE SET NULL,
  netsuite_item_id TEXT NOT NULL,
  item_number TEXT NOT NULL,
  location_id TEXT,
  -- 'delta' = add/remove a number; 'count' = typed the shelf count
  mode TEXT NOT NULL CHECK (mode IN ('delta', 'count')),
  entered_qty NUMERIC(12,2) NOT NULL,
  change NUMERIC(12,2) NOT NULL,
  on_hand_before NUMERIC(12,2),
  reason TEXT NOT NULL,
  note TEXT,
  netsuite_adjustment_id TEXT,
  netsuite_adjustment_number TEXT,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_adjustments_item_idx
  ON inventory_adjustments (netsuite_item_id, created_at DESC);

ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admins can read inventory adjustments' AND tablename = 'inventory_adjustments') THEN
    CREATE POLICY "Admins can read inventory adjustments" ON inventory_adjustments FOR SELECT TO authenticated USING (is_admin());
  END IF;
END $$;
