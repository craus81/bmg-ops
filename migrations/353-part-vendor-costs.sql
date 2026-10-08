-- Migration 353: vendor cost + target margin on catalog parts (owner ask
-- 2026-10-08, from Ashley O.).
--
-- BMG outsources some parts it sells (Masterack graphics and the like). The
-- owner went through every outsourced part number and wrote down what the
-- vendor charges and the margin BMG aims for; Admin → Vendor Costs uploads
-- that spreadsheet onto the catalog.
--
-- Owner decisions: these numbers stay in FleetSuite only (never pushed to
-- NetSuite), and the selling price is still whatever was quoted, so
-- target_margin_pct is a reference the part page shows next to the price,
-- never a formula that sets it.
--
-- Separate from purchase_price on purpose: the hourly parts sync rewrites
-- purchase_price from NetSuite's item cost, which would wipe an upload.
-- The sync upsert names its columns, so it never touches these.

ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS outsource_vendor TEXT;
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS vendor_cost NUMERIC(12, 2);
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS target_margin_pct NUMERIC(5, 2);
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS vendor_cost_updated_at TIMESTAMPTZ;
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS vendor_cost_updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'netsuite_parts_vendor_cost_check') THEN
    ALTER TABLE netsuite_parts ADD CONSTRAINT netsuite_parts_vendor_cost_check
      CHECK (vendor_cost IS NULL OR vendor_cost >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'netsuite_parts_target_margin_pct_check') THEN
    ALTER TABLE netsuite_parts ADD CONSTRAINT netsuite_parts_target_margin_pct_check
      CHECK (target_margin_pct IS NULL OR (target_margin_pct > -100 AND target_margin_pct < 100));
  END IF;
END $$;
