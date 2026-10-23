-- Migration 428: the Send for Review note, kept on the estimate.
--
-- Craig (2026-10-23, thread "Review request note shown on the estimate"):
-- Valarie's review email carried a note ("This is a large spot decal
-- package…"), but opening the estimate from the email showed nothing of it.
-- The note only lived in the email and a cut-short bell notification. Now
-- Send for Review saves it, with the files that went along, and the
-- estimate's In-review box shows it. Each new round moves the last one into
-- internal_review_history so earlier notes and answers stay readable.

-- The requester's note for the CURRENT round. internal_review_note stays the
-- REVIEWER's answer (migration 316).
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS internal_review_request_note TEXT;

-- What the review email carried: [{ "name": "...", "id": "<estimate_files id>" }].
-- The estimate PDF is listed by name only.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS internal_review_request_files JSONB;

-- Earlier rounds, oldest first, capped by the send route:
-- [{ requested_by, requested_at, reviewer_id, request_note, request_files,
--    status, decided_by, decided_at, decision_note }].
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS internal_review_history JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN estimates.internal_review_request_note IS 'Note the requester wrote on Send for Review for the current round. Cleared with the rest of the review.';
COMMENT ON COLUMN estimates.internal_review_history IS 'Earlier internal review rounds (oldest first), moved here when a new Send for Review starts a round.';
