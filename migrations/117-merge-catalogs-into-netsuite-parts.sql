-- Migration 117: Merge the graphics proof catalog into the unified parts catalog
--
-- Phase 1 of folding the hand-maintained `catalog` (+ `catalog_proofs`) tables
-- into `netsuite_parts`, so there is ONE parts catalog. This migration is
-- additive and non-destructive: it adds columns, backfills data, and repoints
-- foreign keys, but does NOT drop the old tables or columns yet (that happens
-- in a later phase, after the code is repointed and verified).
--
-- Conflict policy (chosen): NetSuite price wins. A proof-catalog price only
-- fills `sales_price` where the synced part has none (0/null); existing synced
-- prices are left untouched.

-- ---------------------------------------------------------------------------
-- A. Schema: graphics fields + provenance on the unified catalog
-- ---------------------------------------------------------------------------

-- Graphics metadata that only lived on the proof catalog.
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS vehicle_type    text;
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS graphic_package text;
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS customer        text;    -- brand/source: Masterack, Knapheide, …
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS proof_pages     integer DEFAULT 1;

-- Where a row came from. NetSuite-synced rows are managed by the sync;
-- 'manual' rows (graphics-only parts with no NetSuite item) are not.
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'netsuite'
  CHECK (source IN ('netsuite', 'manual'));

-- Graphics-only parts may have no NetSuite item, so netsuite_id can be NULL.
-- The existing UNIQUE on netsuite_id still holds: Postgres treats NULLs as
-- distinct, so multiple manual rows are fine and the sync's upsert on
-- netsuite_id keeps working.
ALTER TABLE netsuite_parts ALTER COLUMN netsuite_id DROP NOT NULL;

-- Fast case-insensitive lookups by item number (price + PO matching resolve
-- parts case-insensitively; the old proof catalog matched on UPPER(part_number)).
CREATE INDEX IF NOT EXISTS idx_netsuite_parts_item_number_lower
  ON netsuite_parts (lower(item_number));

-- Proof images fold in from the proof catalog WITHOUT moving any storage
-- objects: remember which bucket each file lives in. Existing part_files live
-- in 'graphics-proofs'; folded-in proofs stay in 'proofs'.
ALTER TABLE part_files ADD COLUMN IF NOT EXISTS bucket     text NOT NULL DEFAULT 'graphics-proofs';
ALTER TABLE part_files ADD COLUMN IF NOT EXISTS sort_order integer;
ALTER TABLE part_files ADD COLUMN IF NOT EXISTS label      text;

-- New FK from PO lines + schedule assignments to the unified catalog. Additive:
-- the old catalog_id columns stay in place until the retire phase.
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS part_id uuid REFERENCES netsuite_parts(id);
CREATE INDEX IF NOT EXISTS idx_po_line_items_part ON po_line_items(part_id);

-- schedule_assignments predates the migration runner and only exists in some
-- environments — guard it so this migration doesn't fail where the scheduling
-- table was never created.
DO $$
BEGIN
  IF to_regclass('public.schedule_assignments') IS NOT NULL THEN
    ALTER TABLE schedule_assignments ADD COLUMN IF NOT EXISTS part_id uuid REFERENCES netsuite_parts(id);
    CREATE INDEX IF NOT EXISTS idx_schedule_assignments_part ON schedule_assignments(part_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- B. Backfill: fold proof-catalog rows into netsuite_parts
-- ---------------------------------------------------------------------------

-- 1) Enrich existing (synced) parts that match a proof-catalog row by item
--    number. NetSuite price wins — sales_price is only filled where missing.
--    The proof catalog is deduped to one row per part number.
UPDATE netsuite_parts np
SET
  vehicle_type      = COALESCE(np.vehicle_type, c.vehicle_type),
  graphic_package   = COALESCE(np.graphic_package, c.graphic_package),
  customer          = COALESCE(np.customer, c.customer),
  proof_pages       = COALESCE(c.proof_pages, np.proof_pages, 1),
  billable_customer = COALESCE(NULLIF(np.billable_customer, ''), c.end_customer),
  sales_price       = CASE WHEN COALESCE(np.sales_price, 0) = 0 THEN COALESCE(c.price, 0) ELSE np.sales_price END,
  catalog           = 'graphics',
  updated_at        = now()
FROM (
  SELECT DISTINCT ON (lower(part_number)) *
  FROM catalog
  ORDER BY lower(part_number), active DESC, id
) c
WHERE lower(np.item_number) = lower(c.part_number);

-- 2) Insert proof-catalog rows that have no matching part (graphics-only, not a
--    NetSuite item). netsuite_id stays NULL, source = 'manual'.
INSERT INTO netsuite_parts (
  netsuite_id, item_number, display_name, description, item_type, catalog,
  sales_price, vehicle_type, graphic_package, customer, proof_pages,
  billable_customer, source, is_active, last_synced_at, created_at, updated_at
)
SELECT
  NULL,
  c.part_number,
  COALESCE(
    NULLIF(TRIM(CONCAT_WS(' · ', NULLIF(c.vehicle_type, ''), NULLIF(c.graphic_package, ''))), ''),
    c.part_number
  ),
  NULLIF(c.graphic_package, ''),
  'Graphics',
  'graphics',
  COALESCE(c.price, 0),
  c.vehicle_type,
  c.graphic_package,
  c.customer,
  COALESCE(c.proof_pages, 1),
  c.end_customer,
  'manual',
  COALESCE(c.active, true),
  now(), now(), now()
FROM (
  SELECT DISTINCT ON (lower(part_number)) *
  FROM catalog
  ORDER BY lower(part_number), active DESC, id
) c
WHERE NOT EXISTS (
  SELECT 1 FROM netsuite_parts np WHERE lower(np.item_number) = lower(c.part_number)
);

-- 3) Fold proof images into part_files. Keep them in the 'proofs' bucket (no
--    storage objects move). Idempotent on (part_id, storage_path).
INSERT INTO part_files (part_id, file_name, file_type, file_size, storage_path, bucket, sort_order, label, uploaded_by)
SELECT np.id, cp.file_name, cp.file_type, cp.file_size, cp.file_path, 'proofs', cp.sort_order, cp.label, cp.uploaded_by
FROM catalog_proofs cp
JOIN catalog c          ON c.id = cp.catalog_id
JOIN netsuite_parts np  ON lower(np.item_number) = lower(c.part_number)
WHERE NOT EXISTS (
  SELECT 1 FROM part_files pf WHERE pf.part_id = np.id AND pf.storage_path = cp.file_path
);

-- ---------------------------------------------------------------------------
-- C. Repoint foreign keys from old catalog ids to the new part rows
-- ---------------------------------------------------------------------------

UPDATE po_line_items pli
SET part_id = np.id
FROM catalog c
JOIN netsuite_parts np ON lower(np.item_number) = lower(c.part_number)
WHERE pli.catalog_id = c.id AND pli.part_id IS NULL;

DO $$
BEGIN
  IF to_regclass('public.schedule_assignments') IS NOT NULL THEN
    UPDATE schedule_assignments sa
    SET part_id = np.id
    FROM catalog c
    JOIN netsuite_parts np ON lower(np.item_number) = lower(c.part_number)
    WHERE sa.catalog_id = c.id AND sa.part_id IS NULL;
  END IF;
END $$;
