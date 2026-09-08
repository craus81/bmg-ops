-- R6-3: phone call events from the telephony provider (Dialpad). Two jobs:
-- give the caller-ID screen-pop something to fire on, and give the CRM a
-- record that a call happened even when nobody remembers to log it.
--
-- Append-only by intent: one row per provider call, upserted on the
-- provider's own id so a ringing -> connected -> hangup sequence updates
-- one row instead of stacking three.

CREATE TABLE IF NOT EXISTS phone_call_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'dialpad',
  provider_call_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  state TEXT,
  from_number TEXT,
  to_number TEXT,
  -- Digits only, so it joins the same phone_digits columns the caller-ID
  -- search matches on (migrations 238/239).
  external_digits TEXT,
  matched_prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  /* The staff member the call rang, when the provider names one. */
  target_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  /* Set once a human turns this call into a timeline entry, so the
     "unlogged calls" view stays honest. */
  logged_activity_id UUID REFERENCES prospect_activities(id) ON DELETE SET NULL,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_call_id)
);

CREATE INDEX IF NOT EXISTS idx_phone_call_events_recent ON phone_call_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_call_events_digits ON phone_call_events(external_digits);
CREATE INDEX IF NOT EXISTS idx_phone_call_events_unlogged
  ON phone_call_events(created_at DESC) WHERE logged_activity_id IS NULL;

ALTER TABLE phone_call_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff read phone call events" ON phone_call_events;
CREATE POLICY "Staff read phone call events" ON phone_call_events
  FOR SELECT TO authenticated USING (public.is_internal_staff());
-- Writes come from the provider webhook (service role) only.
