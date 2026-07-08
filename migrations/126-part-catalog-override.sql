-- Some parts land in the wrong catalog: the parts sync classifies by
-- ns_class/item-number prefix (determineCatalog in /api/parts/sync), so a
-- manual re-file would be reverted on the next sync. catalog_override pins a
-- part to a catalog: when set, the sync uses it instead of the derived value.
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS catalog_override TEXT
  CHECK (catalog_override IN ('upfit', 'graphics'));

COMMENT ON COLUMN netsuite_parts.catalog_override IS
  'Manual catalog assignment set from the Parts page. When non-null, the parts sync keeps catalog equal to this instead of deriving it from ns_class / item number.';
