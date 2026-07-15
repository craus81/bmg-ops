-- Backfill support for invoice_emails: track where each row came from
-- ('app' = sent by FleetSuite at send time, 'resend' = pulled from the
-- Resend API history, 'gmail' = found in the connected mailbox's Sent
-- folder) and the source's message id, so re-running the backfill never
-- duplicates rows.
ALTER TABLE invoice_emails ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';
ALTER TABLE invoice_emails ADD COLUMN IF NOT EXISTS source_id TEXT;

-- One row per (source message, invoice) — a multi-invoice email packet
-- yields one row per invoice, all sharing the source_id. Not a partial
-- index: PostgREST upserts infer ON CONFLICT from full indexes only.
-- App-time rows keep source_id NULL, and NULLs are distinct, so this
-- never constrains them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_emails_source_dedupe
  ON invoice_emails(source, source_id, invoice_number);
