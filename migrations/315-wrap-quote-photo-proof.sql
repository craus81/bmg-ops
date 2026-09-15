-- Photo coverage proofs on wrap quotes. Instead of a 1:20 vehicle outline
-- template, the estimator can take a photo of the customer's actual vehicle
-- (uploaded to the vehicle-templates bucket under quote-photos/) and let the
-- rep draw labelled boxes over it to show what gets wrapped. photo_path is
-- that backdrop; photo_boxes is the drawn geometry in photo-pixel coordinates
-- ({id, label, color, rect:{x,y,w,h}}) so a saved quote reopens with its boxes
-- intact.
--
-- These boxes are a PICTURE, not measurements: they carry no inches and never
-- reach pricing (sizing stays the calibrated-template flow's job). On save the
-- estimator flattens photo + boxes to a JPEG and stores it in the existing
-- diagram_path, so the proof rides the quote preview, the emailed quote's
-- "Coverage Areas" block and the estimate attach with no other changes.
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS photo_path TEXT;
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS photo_boxes JSONB NOT NULL DEFAULT '[]'::jsonb;
