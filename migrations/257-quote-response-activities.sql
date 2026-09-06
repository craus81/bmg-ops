-- Quote responses on the customer's account history.
--
-- Emails already land on the customer record's Recent Activity (the send
-- layer writes a type:'email' row), but the customer's ANSWER did not:
-- accepting or rejecting an estimate or wrap quote through the approval
-- link wrote nothing to prospect_activities, so the timeline showed the
-- quote going out and never what came back. Two new activity types, plus
-- a deep link so the row opens the quote it is about.

ALTER TABLE prospect_activities DROP CONSTRAINT IF EXISTS prospect_activities_type_check;
ALTER TABLE prospect_activities
  ADD CONSTRAINT prospect_activities_type_check
  CHECK (type IN ('call', 'email', 'note', 'meeting', 'quote_sent', 'status_change', 'quote_accepted', 'quote_rejected'));

ALTER TABLE prospect_activities ADD COLUMN IF NOT EXISTS url TEXT;

COMMENT ON COLUMN prospect_activities.url IS
  'Deep link to the record this activity is about (src/lib/deep-links.ts), when one exists — the timeline renders it as an Open button.';
