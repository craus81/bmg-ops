-- Migration 440: Outreach, part 4 — "Pick a time" and "Have <rep> call me".
--
-- Owner decision 2026-10-25 (thread "AI outbound sales agent", "they
-- choose"): every Outreach email carries two buttons, and the person who
-- got it picks one. Pick a time books a 20-minute phone call on the rep's
-- FleetSuite schedule (a calendar_events row, category 'sales', linked to
-- the prospect); Call me leaves a number and a best time. Either way the
-- rep gets an alert and the company's row says so. No login, no account:
-- the link's token is the credential (src/app/api/meet/[token]). Nothing
-- is emailed to the customer by this; the page itself confirms.

ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS booking_token TEXT UNIQUE;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS meeting_at TIMESTAMPTZ;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS meeting_event_id UUID REFERENCES calendar_events(id) ON DELETE SET NULL;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS meeting_contact TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS callback_phone TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS callback_when TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS callback_requested_at TIMESTAMPTZ;

ALTER TABLE outreach_targets DROP CONSTRAINT IF EXISTS outreach_targets_status_check;
ALTER TABLE outreach_targets ADD CONSTRAINT outreach_targets_status_check CHECK (status IN (
  'new', 'draft', 'call_first', 'sent', 'replied', 'booked', 'call_back', 'later', 'not_fit', 'unsubscribed'
));
