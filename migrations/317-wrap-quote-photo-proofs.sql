-- Multiple photo coverage proofs per wrap quote, and real sizes on the boxes.
--
-- Migration 315 gave a quote ONE photo (photo_path) and a list of boxes that
-- were a picture only. Two things changed (owner, 2026-09-16): a job needs
-- several views — driver side, passenger side, rear, roof — and the boxes
-- should price like template shapes rather than sit beside the money.
--
-- photo_proofs is an ORDERED array, one entry per photo:
--
--   { id, path, label, diagram_path,
--     calibration: { line?: {x1,y1,x2,y2,inches},
--                    plane?: {corners:[4×{x,y}], widthIn, heightIn} },
--     boxes: [{ id, label, color, rect:{x,y,w,h},
--               qty, substrate_id, width_in, height_in, area_in2,
--               manual, measured_by }] }
--
-- Calibration is PER PHOTO because scale is per photo: a known length fixes
-- the scale in its own plane at its own distance and nowhere else, so the
-- side shot's ruler says nothing about the rear shot. `line` is one known
-- length (right for a square-on photo); `plane` is a known rectangle's four
-- corners, which pins a homography and takes the perspective out of an
-- angled shot (src/lib/photo-scale.ts). Both can be set; the plane wins, and
-- the app compares them — a big disagreement means one of the two references
-- isn't in the same plane as the wrap, which is the mistake that silently
-- misprices a job.
--
-- Sizes reach pricing through the estimator's existing measurement path, so
-- a photo box bills exactly like a shape drawn on a 1:20 template.
ALTER TABLE wrap_quotes
  ADD COLUMN IF NOT EXISTS photo_proofs JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Carry the single-photo quotes (migration 315) into the list shape. Guarded
-- on photo_proofs still being empty, so re-running the pipeline (preview
-- builds skip migrations; a re-deploy re-runs them) can't duplicate a proof
-- or clobber boxes drawn since.
UPDATE wrap_quotes
SET photo_proofs = jsonb_build_array(
      jsonb_build_object(
        'id', gen_random_uuid()::text,
        'path', photo_path,
        'label', '',
        'diagram_path', diagram_path,
        'boxes', COALESCE(photo_boxes, '[]'::jsonb)
      ))
WHERE photo_path IS NOT NULL
  AND (photo_proofs IS NULL OR jsonb_array_length(photo_proofs) = 0);

COMMENT ON COLUMN wrap_quotes.photo_proofs IS 'Ordered photo coverage proofs: one entry per photo with its boxes, its own calibration, and its flattened picture. Supersedes photo_path/photo_boxes (migration 315), which are kept only so an unmigrated row can still be read.';
