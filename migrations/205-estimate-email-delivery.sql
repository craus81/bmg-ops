-- Estimate approval emails get the invoice-style delivery tracking: a
-- bounced approval email looked identical to a delivered one — the app said
-- "sent", the customer never saw it, and the estimate just sat unanswered.
-- The send path records the Resend message id on the estimate; the Resend
-- webhook (/api/webhooks/resend) updates the status and alerts the sales
-- side on bounce/complaint/failure.
--
-- Columns live on estimates (not a log table like invoice_emails) because
-- only the LATEST send matters here: resending rotates the approval token,
-- which invalidates prior links anyway.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS approval_email_id TEXT,
  ADD COLUMN IF NOT EXISTS approval_email_to TEXT[],
  ADD COLUMN IF NOT EXISTS approval_email_status TEXT
    CHECK (approval_email_status IN ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed')),
  ADD COLUMN IF NOT EXISTS approval_email_detail TEXT,
  ADD COLUMN IF NOT EXISTS approval_email_updated_at TIMESTAMPTZ;

-- Webhook lookups are by Resend message id.
CREATE INDEX IF NOT EXISTS idx_estimates_approval_email_id
  ON estimates(approval_email_id)
  WHERE approval_email_id IS NOT NULL;

COMMENT ON COLUMN estimates.approval_email_status IS 'Delivery state of the LATEST approval email: sent → delivered, or bounced/complained/failed/delivery_delayed via the Resend webhook. NULL = never emailed (or sent before tracking existed).';
