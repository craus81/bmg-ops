-- Emails on the customer's account history (field ask, 2026-08-21: "record
-- that an email was sent, so a separate note doesn't have to be added…
-- it would be nice to see the email that was written too").
--
-- email_log (206) becomes the content + customer store: the send layer now
-- resolves the customer/prospect behind each send (ids passed by the flow's
-- EmailMeta) and keeps the rendered HTML for human-composed sends. Each
-- composed send with a resolved prospect also gets a 'email' row on the
-- prospect_activities timeline, pointing back at the log row so the entry
-- can open the actual email.
ALTER TABLE email_log
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS body_html TEXT;

CREATE INDEX IF NOT EXISTS idx_email_log_customer
  ON email_log(customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_log_prospect
  ON email_log(prospect_id, created_at DESC)
  WHERE prospect_id IS NOT NULL;

ALTER TABLE prospect_activities
  ADD COLUMN IF NOT EXISTS email_log_id UUID REFERENCES email_log(id) ON DELETE SET NULL;
