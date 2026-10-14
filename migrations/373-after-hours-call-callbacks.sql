-- After-hours Calls page (owner ask 2026-10-14): each after-hours call
-- opens its own page, and whoever returns the call ticks "Called back".

ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS called_back_at TIMESTAMPTZ;
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS called_back_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_phone_call_events_retell_recent
  ON phone_call_events(created_at DESC) WHERE provider = 'retell';
