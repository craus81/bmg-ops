-- Migration 299: CNI photo pre-screen (R6-8)
--
-- A vision check at upload, while the crew is still standing next to the
-- vehicle: is this the angle it was filed as, is the VIN plate legible and
-- does it read as the VIN on the row, is it blurry or dark, is the install
-- actually visible.
--
-- THE VERDICT LIVES IN ITS OWN COLUMNS AND NEVER TOUCHES review_status.
-- A model that misreads a legitimate night-shift photo would otherwise send
-- a crew back out for nothing, and a model that waves through a bad one
-- would launder itself as a human approval. The pre-screen advises; the
-- reviewer decides, and can see what the pre-screen thought.
ALTER TABLE cni_job_photos
  ADD COLUMN IF NOT EXISTS prescreen_verdict TEXT
    CHECK (prescreen_verdict IN ('pass', 'retake', 'unsure', 'not_screened')),
  ADD COLUMN IF NOT EXISTS prescreen_notes TEXT,
  ADD COLUMN IF NOT EXISTS prescreen_at TIMESTAMPTZ,
  -- The individual findings, so the UI can say WHICH check failed rather
  -- than showing a bare verdict, and so a later prompt change can be
  -- evaluated against what the old one actually reported.
  ADD COLUMN IF NOT EXISTS prescreen_findings JSONB;

COMMENT ON COLUMN cni_job_photos.prescreen_verdict IS
  'Migration 299: advisory vision pre-screen result. pass / retake / unsure / not_screened (the check did not run — which is NOT a pass). Never gates review_status: a human reviewer still decides.';

-- The installer photo page reads pending pre-screens for the VIN in hand.
CREATE INDEX IF NOT EXISTS idx_cni_job_photos_prescreen
  ON cni_job_photos(vin_id, prescreen_verdict)
  WHERE prescreen_verdict IS NOT NULL;
