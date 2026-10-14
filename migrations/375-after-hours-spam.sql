-- Spam list for after-hours calls (owner ask 2026-10-14): staff mark a junk
-- call as spam, it leaves the After-hours Calls log, and later calls from
-- the same caller ID are filed under Spam with no email, bell or push.

ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS spam BOOLEAN NOT NULL DEFAULT false;

-- One row per blocked caller ID, keyed on the last 10 digits (phoneDigits).
CREATE TABLE IF NOT EXISTS phone_spam_numbers (
  digits TEXT PRIMARY KEY,
  added_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The call it was marked from, so the Spam tab can say why.
  source_call_id UUID REFERENCES phone_call_events(id) ON DELETE SET NULL
);

-- Server routes use the service role; no browser access.
ALTER TABLE phone_spam_numbers ENABLE ROW LEVEL SECURITY;
