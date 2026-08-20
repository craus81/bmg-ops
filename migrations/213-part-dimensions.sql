-- Migration 213: physical dimensions on catalog parts (upfit configurator, phase 1)
--
-- Craig 2026-08-20: the 3D upfit designer places real products inside a real
-- cargo box, which needs each placeable part's installed footprint. These are
-- FleetSuite-owned columns in the migration-197 sense: the NetSuite parts sync
-- upserts a FIXED column list (src/lib/parts-sync.ts), so values written here
-- survive every sync. Do NOT add these columns to the sync payload.
--
-- Dimensions are as-installed: width_in runs along the wall the part mounts
-- to (left-right of the part as you face it), depth_in is how far it sticks
-- out into the cargo area, height_in is vertical. NULL dims = the part can't
-- be placed in the 3D scene (it still rides parts lists and estimates via the
-- designer's "unplaced" bucket).
--
-- dims_source mirrors part_fitment.source so harvested numbers can be told
-- apart from human ones: 'vendor_site' (scraped from the vendor product page),
-- 'pdf_vision' (extracted from a spec PDF by scripts/extract-part-dimensions),
-- 'manual' (typed in /admin/part-dimensions — never overwritten by imports).

ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS width_in NUMERIC(6,2);
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS depth_in NUMERIC(6,2);
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS height_in NUMERIC(6,2);
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS weight_lb NUMERIC(7,2);
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS mount_type TEXT;
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS dims_source TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'netsuite_parts_mount_type_check') THEN
    ALTER TABLE netsuite_parts ADD CONSTRAINT netsuite_parts_mount_type_check
      CHECK (mount_type IS NULL OR mount_type IN ('floor', 'wall', 'door', 'partition', 'ceiling', 'accessory'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'netsuite_parts_dims_source_check') THEN
    ALTER TABLE netsuite_parts ADD CONSTRAINT netsuite_parts_dims_source_check
      CHECK (dims_source IS NULL OR dims_source IN ('vendor_site', 'pdf_vision', 'manual'));
  END IF;
END $$;

COMMENT ON COLUMN netsuite_parts.width_in IS 'Installed footprint left-right (in), along the mounting wall. NULL = not placeable in the 3D designer.';
COMMENT ON COLUMN netsuite_parts.depth_in IS 'Installed footprint into the cargo area (in).';
COMMENT ON COLUMN netsuite_parts.height_in IS 'Installed height (in).';
COMMENT ON COLUMN netsuite_parts.mount_type IS 'Where the part lives in a layout: floor|wall|door|partition|ceiling|accessory. Drives the designer''s default placement zone.';
COMMENT ON COLUMN netsuite_parts.dims_source IS 'Who authored the dims: vendor_site|pdf_vision|manual. Imports only fill blanks and never overwrite manual.';
