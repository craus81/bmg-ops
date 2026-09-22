-- Migration 307: Retire the CNI photo approve/deny review
--
-- Owner decision (2026-09-12): judging an outside installer's completion
-- photos after the fact is gone. The photos are documentation of what was
-- installed, not a thing to pass or fail — and a verdict on them only ever
-- produced work: a reviewer clicking approve on every photo of a job that
-- was obviously fine, a denial that sent a crew back across the state for a
-- reshoot, and a "first-pass rate" scored against installers from it.
--
-- The photos themselves, the required-angles set, and the submit step all
-- stay. What goes is the verdict: /api/cni/review-photo is deleted, the
-- admin Photo Review screen becomes a plain gallery, and no code reads or
-- writes the columns below.
--
-- NOTHING IS DROPPED HERE. The verdict columns keep every past approval and
-- denial so the history stays legible, and review_status keeps its NOT NULL
-- DEFAULT 'pending' so inserts that no longer mention it still work. This
-- migration only records that they are dead, in the one place a person
-- reading the schema will look.
--
-- The R6-8 advisory pre-screen (migration 299, prescreen_* columns) is
-- UNAFFECTED and stays live — it flags a blurry or wrong-angle shot to the
-- installer at upload, while they are still standing at the vehicle. It
-- never set a verdict; that was always the point of keeping it separate.

COMMENT ON COLUMN cni_job_photos.review_status IS
  'DEPRECATED (migration 307, 2026-09-12): the photo approve/deny review was retired. Retained for history only — no code reads or writes it. Still NOT NULL DEFAULT ''pending'', so rows inserted without it are fine.';

COMMENT ON COLUMN cni_job_photos.reviewed_by IS
  'DEPRECATED (migration 307): photo review retired. Historical rows only.';

COMMENT ON COLUMN cni_job_photos.reviewed_at IS
  'DEPRECATED (migration 307): photo review retired. Historical rows only.';

COMMENT ON COLUMN cni_job_photos.review_notes IS
  'DEPRECATED (migration 307): photo review retired. Historical rows only.';

COMMENT ON COLUMN cni_job_vins.photos_approved IS
  'DEPRECATED (migration 307): photo review retired. Never written after 2026-09-12 and read by nothing — do not gate on it.';

COMMENT ON COLUMN cni_job_vins.photo_review_notes IS
  'DEPRECATED (migration 307): photo review retired. Historical rows only.';

-- photos_submitted is NOT deprecated: it still marks that the installer
-- finished a VIN's required angles, which gates completion on guide jobs.
COMMENT ON COLUMN cni_job_vins.photos_submitted IS
  'The installer has uploaded every required photo angle for this VIN. Gates VIN completion on jobs carrying a dimensioned install guide (see /api/cni/complete-vin). This is about photos EXISTING — it is not a quality verdict, which was retired in migration 307.';
