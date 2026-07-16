-- Dedupe vehicle_templates and block future duplicates.
--
-- Bulk ZIP re-uploads had no uniqueness guard, so re-importing the same
-- archive doubled the whole template library. A duplicate is the same
-- (make, model, year, variant, name) tuple, case-insensitively — the exact
-- identity the bulk uploader derives from the folder structure + filename.
--
-- Keeper preference within a duplicate group: still-active row first, then
-- calibrated (px_per_in set), then one with a preview image, then oldest.
-- wrap_quotes referencing a losing row are repointed to the keeper before
-- the delete. R2 files (originals/previews) of deleted rows become orphans
-- and can be cleaned up later — same call as migration 129 made for
-- quote-proofs.

CREATE TEMP TABLE vt_dupes ON COMMIT DROP AS
WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY lower(make), lower(model),
                        lower(coalesce(year, '')), lower(coalesce(variant, '')),
                        lower(name)
           ORDER BY (is_active IS NOT FALSE) DESC,
                    (px_per_in IS NOT NULL) DESC,
                    (template_image_path IS NOT NULL) DESC,
                    created_at ASC NULLS LAST,
                    id ASC
         ) AS keeper_id
  FROM vehicle_templates
)
SELECT id, keeper_id FROM ranked WHERE id <> keeper_id;

UPDATE wrap_quotes wq
SET template_id = d.keeper_id
FROM vt_dupes d
WHERE wq.template_id = d.id;

DELETE FROM vehicle_templates vt
USING vt_dupes d
WHERE vt.id = d.id;

-- Authoritative guard: the app checks before inserting, but the index wins
-- races and covers any future insert path.
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_templates_identity_uniq
  ON vehicle_templates (
    lower(make), lower(model),
    lower(coalesce(year, '')), lower(coalesce(variant, '')),
    lower(name)
  );
