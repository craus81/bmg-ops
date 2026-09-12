-- Orphan Sales-Order Matchmaker (R6-13, audit line 424)
--
-- The SO sync (migration 196) links a mirrored sales order to its estimate
-- only on an EXACT signal: createdfrom, otherrefnum, or a memo hit. Orders
-- raised by hand in NetSuite carry none of those, so they sit with
-- estimate_id NULL forever and the estimate they came from never learns it
-- converted.
--
-- This table holds SUGGESTIONS, not links. A nightly pass scores each orphan
-- against the open estimates for the SAME NetSuite customer and writes what
-- it found, with the signals that fired. Nothing here changes
-- netsuite_sales_orders.estimate_id or estimates.netsuite_so_id — a person
-- accepts a suggestion and the accept does the linking, because a wrong
-- automatic link silently misattributes revenue and there is no signal
-- afterwards that anything went wrong.

CREATE TABLE IF NOT EXISTS so_match_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  so_id UUID NOT NULL REFERENCES netsuite_sales_orders(id) ON DELETE CASCADE,
  estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,

  -- 0-100. The weights live in src/lib/so-matchmaker.ts; this is what they
  -- produced for this pair on the run named below.
  score NUMERIC(5,2) NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  -- One line naming the signals that actually fired. Never a summary of
  -- signals that did not.
  rationale TEXT NOT NULL,
  -- {customer, total, date, lines} — each with the raw values compared, so
  -- a reviewer can check the claim instead of trusting the score.
  signals JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Did the free-text line comparison run? NULL = never attempted (the
  -- numbers were decisive, or the model was unavailable). Explicit so a
  -- rationale can never imply a comparison that did not happen.
  text_compared BOOLEAN,
  text_verdict TEXT,

  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'accepted', 'rejected', 'superseded')),
  decided_by UUID REFERENCES profiles(id),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (so_id, estimate_id)
);

CREATE INDEX IF NOT EXISTS idx_so_match_open
  ON so_match_suggestions(status, score DESC)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_so_match_so ON so_match_suggestions(so_id);
CREATE INDEX IF NOT EXISTS idx_so_match_estimate ON so_match_suggestions(estimate_id);

ALTER TABLE so_match_suggestions ENABLE ROW LEVEL SECURITY;

-- Staff read; every write goes through the service role (the nightly pass
-- and the accept/reject route), which re-checks the caller.
DROP POLICY IF EXISTS "Staff read so match suggestions" ON so_match_suggestions;
CREATE POLICY "Staff read so match suggestions" ON so_match_suggestions
  FOR SELECT TO authenticated USING (public.is_internal_staff());

-- Accepting a suggestion links the order, and that link needs its own
-- provenance. Reusing 'memo' would claim a memo signal fired when what
-- actually happened is that a person agreed with a score.
ALTER TABLE netsuite_sales_orders DROP CONSTRAINT IF EXISTS netsuite_sales_orders_match_source_check;
ALTER TABLE netsuite_sales_orders ADD CONSTRAINT netsuite_sales_orders_match_source_check
  CHECK (match_source IN ('createdfrom', 'otherrefnum', 'memo', 'suggested'));
