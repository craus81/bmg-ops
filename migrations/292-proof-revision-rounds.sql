-- R6-10: proof revisions as first-class rounds.
--
-- Proof approval state lives as single columns on graphics_jobs
-- (sent_for_approval_at, customer_rejected_at, customer_rejection_reason,
-- approval_proof_file_id, …). One approval at a time, overwritten on the
-- next send. So the second time a customer rejects a proof, the FIRST
-- rejection's reason is gone — and with it the only record of what the
-- designer was asked to fix. Nobody can answer "how many rounds did this
-- job take, and what did they want changed each time?"
--
-- Each round is now its own row: what it was addressing (the previous
-- round's rejection reason), which file was sent, and how it ended.
-- graphics_jobs keeps its columns as the CURRENT state — this table is
-- the history beside it, not a replacement, so every existing reader
-- keeps working untouched.

CREATE TABLE IF NOT EXISTS graphics_proof_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES graphics_jobs(id) ON DELETE CASCADE,
  -- 1-based. Round 1 is the first proof, not a revision.
  round_number INTEGER NOT NULL CHECK (round_number >= 1),

  -- The prior round's rejection reason, copied forward at send time so
  -- the approval page can say "Revision 2 — addressing: <reason>". Copied
  -- rather than joined: the customer is owed the words they were shown,
  -- and editing history later must not rewrite what a past page said.
  addressing TEXT,

  proof_file_id UUID REFERENCES graphics_job_files(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,

  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'approved', 'rejected', 'superseded')),
  decided_at TIMESTAMPTZ,
  rejection_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A decided round must say when. 'superseded' is the exception: a round
  -- abandoned by a re-send was never decided by anybody.
  CONSTRAINT proof_round_decided_has_time
    CHECK (outcome IN ('pending', 'superseded') OR decided_at IS NOT NULL),
  CONSTRAINT proof_round_rejection_has_reason
    CHECK (outcome <> 'rejected' OR rejection_reason IS NOT NULL)
);

COMMENT ON TABLE graphics_proof_rounds IS
  'One row per proof sent to a customer (R6-10). History beside graphics_jobs'' current-state columns, never a replacement for them.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_proof_rounds_job_number
  ON graphics_proof_rounds(job_id, round_number);
CREATE INDEX IF NOT EXISTS idx_proof_rounds_job
  ON graphics_proof_rounds(job_id, created_at);
-- The open round for a job: at most one can be awaiting a customer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proof_rounds_one_pending
  ON graphics_proof_rounds(job_id) WHERE outcome = 'pending';

ALTER TABLE graphics_proof_rounds ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Staff read proof rounds' AND tablename = 'graphics_proof_rounds'
  ) THEN
    CREATE POLICY "Staff read proof rounds" ON graphics_proof_rounds
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- Backfill one round for every job that has already been sent, so the
-- round count on the board isn't blank for live work. Approved and
-- rejected jobs carry their real outcome; anything else reads pending.
-- History before this migration only ever kept ONE round's worth of
-- state, so that is honestly all this can reconstruct — a job that
-- actually took three rounds backfills as one, and its count starts
-- being true from the next send.
INSERT INTO graphics_proof_rounds
  (job_id, round_number, proof_file_id, sent_at, sent_by, outcome, decided_at, rejection_reason)
SELECT
  j.id, 1, j.approval_proof_file_id, j.sent_for_approval_at, j.sent_for_approval_by,
  CASE
    WHEN j.customer_approved_at IS NOT NULL THEN 'approved'
    WHEN j.customer_rejected_at IS NOT NULL AND j.customer_rejection_reason IS NOT NULL THEN 'rejected'
    ELSE 'pending'
  END,
  COALESCE(j.customer_approved_at, j.customer_rejected_at),
  -- Only on a round that actually ENDED in rejection. A job rejected and
  -- later approved has customer_rejected_at still set, and carrying that
  -- reason onto an approved round would be false history.
  CASE
    WHEN j.customer_approved_at IS NULL
     AND j.customer_rejected_at IS NOT NULL THEN j.customer_rejection_reason
  END
FROM graphics_jobs j
WHERE j.sent_for_approval_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM graphics_proof_rounds r WHERE r.job_id = j.id)
ON CONFLICT DO NOTHING;
