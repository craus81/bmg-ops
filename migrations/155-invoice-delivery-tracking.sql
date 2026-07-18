-- Invoice delivery tracking: a bounced invoice email looked identical to a
-- delivered one — until it became a 60-day AR surprise. invoice_emails now
-- carries a delivery status updated by the Resend webhook
-- (/api/webhooks/resend), and the send path records the Resend message id
-- so webhook events can find their row.

ALTER TABLE invoice_emails
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'sent'
    CHECK (delivery_status IN ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed')),
  ADD COLUMN IF NOT EXISTS delivery_detail TEXT,
  ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ;

-- Webhook lookups are by Resend message id.
CREATE INDEX IF NOT EXISTS idx_invoice_emails_source_id
  ON invoice_emails(source_id)
  WHERE source_id IS NOT NULL;

COMMENT ON COLUMN invoice_emails.delivery_status IS 'Resend delivery state: sent (default) → delivered, or bounced/complained/failed/delivery_delayed via webhook.';
