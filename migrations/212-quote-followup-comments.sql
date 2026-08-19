-- Quote follow-up comments + reminders.
--
-- Logging a follow-up used to be a bare timestamp (last_followup_at on the
-- quote). Now each log carries what the customer said and, optionally, a
-- date to be reminded on ("vehicles arrive in September — remind me Sept 1").
-- The daily quote-followup cron delivers due reminders and holds the quiet
-- nudge while a future reminder is pending (the rep deliberately deferred).
--
-- All reads/writes go through /api/quotes/follow-up with the service role
-- (role-gated to admin/sales there), so RLS is enabled with no policies —
-- direct client access stays closed.

CREATE TABLE IF NOT EXISTS quote_followups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quote_type TEXT NOT NULL CHECK (quote_type IN ('estimate', 'wrap')),
  quote_id UUID NOT NULL,
  note TEXT,
  remind_at DATE,
  reminder_sent_at TIMESTAMPTZ,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quote_followups_quote
  ON quote_followups(quote_type, quote_id);
-- The cron scans for due, undelivered reminders.
CREATE INDEX IF NOT EXISTS idx_quote_followups_pending_reminder
  ON quote_followups(remind_at) WHERE reminder_sent_at IS NULL AND remind_at IS NOT NULL;

ALTER TABLE quote_followups ENABLE ROW LEVEL SECURITY;
