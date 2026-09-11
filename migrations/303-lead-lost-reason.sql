-- Record-level lost reasons (R6-9), for the quiet-lead triage queue.
--
-- Migration 263 gave DEALS a typed lost_reason, so the win/loss funnel can
-- answer "what share of losses are price". Records had no such field: a lead
-- could be closed as lost with the reason living only in a timeline note, so
-- the same question about leads — as opposed to deals — was unanswerable.
-- Same vocabulary as 263 on purpose; two different lists for the same
-- question would make the two un-mergeable.

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_lost_reason_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_lost_reason_check
  CHECK (lost_reason IS NULL OR lost_reason IN ('price', 'timing', 'competitor', 'no_response', 'other'));

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS lost_note TEXT;

COMMENT ON COLUMN prospects.lost_reason IS
  'Why this LEAD was closed as lost (the triage queue requires one). Deal-level losses keep their own reason on prospect_opportunities — same vocabulary, different grain.';
