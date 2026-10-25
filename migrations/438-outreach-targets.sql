-- Migration 438: Outreach, part 2 — the weekly list of new companies.
--
-- Owner decision 2026-10-25 (thread "AI outbound sales agent", "Ship it"):
-- every Monday each rep (Sales role) gets 25 companies BMG has never dealt
-- with, within 100 miles of O'Fallon: fleets from the federal DOT carrier
-- census, trade contractors (plumbing, HVAC, electrical, ...) from Google
-- business listings. Later parts add a researched email draft per company
-- that the rep reviews and sends (nothing sends itself), the pick-a-time /
-- call-me page, and a week-later follow-up draft.
--
-- One row per company, ever: (source, source_id) is unique, so a company
-- found once is never handed out again, whichever rep had it and whatever
-- they decided. Companies already in Customers or Prospects are skipped
-- before they get a row (src/lib/outreach-batch.ts).
--
-- Service role only (the /api/outreach routes); RLS on with no policies.

CREATE TABLE IF NOT EXISTS outreach_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('dot', 'google')),
  -- USDOT number, or Google place id.
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fleet', 'trade')),
  company_name TEXT NOT NULL,
  -- What the trade search was for ('Plumbing', 'HVAC', ...); null for fleets.
  trade TEXT,
  street TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  miles INT,
  phone TEXT,
  email TEXT,
  website TEXT,
  -- DOT power units (trucks and tractors), when the source says.
  fleet_size INT,
  -- Everything else the source said, for the research step and the "why
  -- this company" box: drivers, carrier operation, Google types, rating count.
  facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  rep_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- The Monday (Chicago) of the batch it was handed out in.
  week_of DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'draft', 'call_first', 'sent', 'replied', 'booked', 'later', 'not_fit', 'unsubscribed'
  )),
  status_changed_at TIMESTAMPTZ,
  -- Set when the company becomes a prospect (its first send, in part 3).
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_outreach_targets_rep_week ON outreach_targets (rep_id, week_of);
CREATE INDEX IF NOT EXISTS idx_outreach_targets_status ON outreach_targets (status);

ALTER TABLE outreach_targets ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE outreach_targets IS
  'Outreach: new companies handed to a rep each Monday (25 per Sales rep, 100 miles of O''Fallon). One row per company ever; see migration 438.';
