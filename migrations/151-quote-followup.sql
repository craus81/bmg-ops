-- Quote follow-up queue: sent quotes age visibly, reps get nudged after
-- quiet days, and wrap quotes finally get an accepted/rejected state.

-- Wrap quotes could only ever be draft|sent — no way to record a win.
ALTER TABLE wrap_quotes DROP CONSTRAINT IF EXISTS wrap_quotes_status_check;
ALTER TABLE wrap_quotes ADD CONSTRAINT wrap_quotes_status_check
  CHECK (status IN ('draft', 'sent', 'accepted', 'rejected'));
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

-- Follow-up tracking on both quote types: when someone last chased it,
-- and when the rep was last nudged about it (so the daily check doesn't
-- re-ping every morning).
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS followup_nudged_at TIMESTAMPTZ;
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ;
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS followup_nudged_at TIMESTAMPTZ;
