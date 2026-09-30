-- Migration 332: rack kits (Prime Design ErgoRack / AluRack, Craig 2026-09-30)
--
-- A rack kit is a part_kits row with its own part number (item_number,
-- e.g. "AR1205-S"). Unlike a plain package, a kit STAYS a kit on the
-- estimate: it shows as one priced line (the rack) with its components
-- indented beneath it, quantity only. The kit exists in FleetSuite only —
-- the components are the real NetSuite inventory items, so they are what
-- gets stocked, ordered and sent on the sales order.
--
-- Components are keyed by item_number so a kit can be imported before its
-- parts exist in NetSuite: part_id fills in when the catalog has the part,
-- and readers fall back to an item_number match against netsuite_parts.

ALTER TABLE part_kits ADD COLUMN IF NOT EXISTS item_number TEXT;
ALTER TABLE part_kits ADD COLUMN IF NOT EXISTS vendor TEXT;
-- The vendor's short catalog description ("ALURACK 6.5 FT CHANNEL MOUNT - MOD").
ALTER TABLE part_kits ADD COLUMN IF NOT EXISTS short_description TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_part_kits_item_number
  ON part_kits (upper(item_number)) WHERE item_number IS NOT NULL;

ALTER TABLE part_kit_items ALTER COLUMN part_id DROP NOT NULL;
ALTER TABLE part_kit_items ADD COLUMN IF NOT EXISTS item_number TEXT;
ALTER TABLE part_kit_items ADD COLUMN IF NOT EXISTS description TEXT;

-- Existing package members get their part number so every member row can
-- be matched the same way.
UPDATE part_kit_items ki
   SET item_number = p.item_number
  FROM netsuite_parts p
 WHERE ki.part_id = p.id
   AND ki.item_number IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_part_kit_items_item_number
  ON part_kit_items (kit_id, upper(item_number)) WHERE item_number IS NOT NULL;

-- ── Estimate lines: which kit a component line belongs to ──
-- Component lines stay ordinary priced item lines (so totals, tax, stock
-- checks and the NetSuite push are unchanged); these columns only group
-- them under the kit's heading on every customer surface.
--   kit_group_id   one kit on the estimate (all its component lines share it)
--   kit_quantity   how many racks; component qty = per-kit qty × this
ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS kit_group_id UUID;
ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS kit_id UUID REFERENCES part_kits(id) ON DELETE SET NULL;
ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS kit_item_number TEXT;
ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS kit_name TEXT;
ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS kit_quantity NUMERIC;

COMMENT ON COLUMN part_kits.item_number IS
  'Set on rack kits (e.g. Prime Design AR1205-S): the kit keeps its identity on estimates as a priced heading over its components. NULL = a plain package that explodes into ordinary lines.';
