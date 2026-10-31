-- Generic parts (Craig, 2026-10-30): parts like Miscellaneous stand in for a
-- different job on every estimate, so their labor is set on each estimate
-- line and never saved to the part. Admins tick "Generic part" on the Parts
-- page; Misc/Miscellaneous start out ticked, and the labor that had been
-- saved onto them goes back to "not set" (NULL, migration 258).
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS is_generic boolean NOT NULL DEFAULT false;

UPDATE netsuite_parts
SET is_generic = true, labor_hours = NULL, updated_at = now()
WHERE is_generic = false
  AND (item_number ILIKE 'misc%' OR display_name ILIKE 'misc%');
