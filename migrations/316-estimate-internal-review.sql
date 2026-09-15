-- Internal review step on estimates: before an estimate goes to the
-- customer, the rep can send it to a BMG teammate (an admin, an owner) who
-- reads it, edits it if needed, and either hands it back with notes,
-- approves it for the rep to send, or sends it to the customer themselves.
--
-- Deliberately NOT part of estimates.status: that column describes where the
-- estimate stands WITH THE CUSTOMER (draft → sent → accepted/rejected →
-- pushed) and is read by the follow-up cron, the open-quotes math, the
-- convert gate and the NetSuite push. An internal round trip must not move
-- any of that, so review state lives in its own columns and nothing outside
-- the review UI reads them.
--
-- The step is optional by design (owner decision 2026-09-15): a rep can
-- still send straight to the customer. Sending to the customer while a
-- review is pending resolves it as approved by whoever sent, so an estimate
-- can't sit "in review" after the customer already has it.
ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS internal_review_status TEXT
    CHECK (internal_review_status IS NULL
           OR internal_review_status IN ('pending', 'approved', 'changes_requested')),
  -- Who owns the review right now. Re-sending to someone else reassigns it.
  ADD COLUMN IF NOT EXISTS internal_reviewer_id UUID REFERENCES profiles(id),
  -- Who asked (the rep the decision goes back to).
  ADD COLUMN IF NOT EXISTS internal_review_requested_by UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS internal_review_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS internal_review_decided_by UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS internal_review_decided_at TIMESTAMPTZ,
  -- The reviewer's note on the LATEST decision — what they changed, or what
  -- they want changed. Cleared when a fresh review is requested, so a stale
  -- "fix the labor line" can't hang over an estimate that already fixed it.
  ADD COLUMN IF NOT EXISTS internal_review_note TEXT;

-- The reviewer's own queue ("what's waiting on me") reads this.
CREATE INDEX IF NOT EXISTS idx_estimates_internal_reviewer
  ON estimates(internal_reviewer_id)
  WHERE internal_review_status = 'pending';

COMMENT ON COLUMN estimates.internal_review_status IS 'Internal (BMG-side) review of the estimate: pending → approved | changes_requested. NULL = never sent for review. Independent of estimates.status, which tracks the CUSTOMER side.';
COMMENT ON COLUMN estimates.internal_review_note IS 'The reviewer''s note on the latest decision. Cleared when a new review is requested.';
