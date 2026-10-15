-- Migration 378: proofs can go to the rep before the customer.
--
-- Owner decision 2026-10-15 (thread "Proof routing on graphics jobs"):
-- whoever enters a graphics job picks where its proof goes. "Customer" is
-- today's flow (the artist sends the approval link straight out). "Rep
-- reviews first" sends the proof to a BMG rep instead; the rep then sends
-- it to the customer through the normal approval email, records that the
-- customer approved it verbally (a note is required, and that counts as
-- the approval), or sends it back to the artist with notes.
--
-- graphics_jobs keeps the CURRENT rep review, like the customer approval
-- columns beside it; each step also writes a graphics_status_history note.

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS proof_route TEXT NOT NULL DEFAULT 'customer',
  -- NULL = the person who entered the job (created_by).
  ADD COLUMN IF NOT EXISTS proof_rep_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rep_review_status TEXT,
  ADD COLUMN IF NOT EXISTS rep_review_proof_file_id UUID REFERENCES graphics_job_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rep_review_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rep_review_requested_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- The artist's note to the rep.
  ADD COLUMN IF NOT EXISTS rep_review_note TEXT,
  ADD COLUMN IF NOT EXISTS rep_review_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rep_review_decided_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- What the rep asked the artist to change.
  ADD COLUMN IF NOT EXISTS rep_review_reason TEXT,
  -- Set when a rep recorded the customer's approval by hand; how the
  -- customer approved (customer_approved_by holds who recorded it).
  ADD COLUMN IF NOT EXISTS approval_verbal_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'graphics_jobs_proof_route_check') THEN
    ALTER TABLE graphics_jobs ADD CONSTRAINT graphics_jobs_proof_route_check
      CHECK (proof_route IN ('customer', 'rep'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'graphics_jobs_rep_review_status_check') THEN
    ALTER TABLE graphics_jobs ADD CONSTRAINT graphics_jobs_rep_review_status_check
      CHECK (rep_review_status IS NULL
        OR rep_review_status IN ('pending', 'sent_to_customer', 'changes_requested', 'approved_verbally'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_graphics_jobs_rep_review_pending
  ON graphics_jobs(rep_review_requested_at)
  WHERE rep_review_status = 'pending';

COMMENT ON COLUMN graphics_jobs.proof_route IS 'Where the proof goes: customer (straight out) or rep (rep reviews first, then passes it on).';
COMMENT ON COLUMN graphics_jobs.proof_rep_id IS 'The rep who reviews the proof first; NULL means whoever entered the job (created_by).';
COMMENT ON COLUMN graphics_jobs.approval_verbal_note IS 'Set when a rep recorded the customer''s approval by hand: how the customer approved.';
