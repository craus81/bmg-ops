-- 271: Reorder points & auto-replenishment (R4-7).
--
-- Per-part min/max levels on the catalog. NULL reorder_point = this part is
-- not managed by the sweep (the default for all 3,000+ parts — opt-in only).
-- These are FleetSuite-owned columns with no NetSuite counterpart: the parts
-- sync's partial upsert (src/lib/parts-sync.ts) never names them, so synced
-- refreshes leave them alone — do NOT add them to the sync's column list.
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS reorder_point NUMERIC(14,2);
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS order_up_to NUMERIC(14,2);
COMMENT ON COLUMN netsuite_parts.reorder_point IS
  'Reorder when free stock + on-order falls to this level. NULL = not managed by the nightly reorder sweep.';
COMMENT ON COLUMN netsuite_parts.order_up_to IS
  'Target level the auto-reorder suggestion fills up to. NULL falls back to reorder_point.';

-- Where a purchase request came from. NULL = raised by a person (the
-- historical rows); 'auto_reorder' = the nightly reorder sweep.
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS source TEXT;
COMMENT ON COLUMN purchase_requests.source IS
  'NULL = raised by a person; ''auto_reorder'' = raised by the nightly reorder sweep (R4-7).';
