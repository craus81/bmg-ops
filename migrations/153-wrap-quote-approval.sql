-- Wrap-quote customer acceptance: the same E-SIGN-grade magic-link flow
-- estimates have (migration 082), extended to wrap quotes. The emailed
-- quote carries a tokenized "Review & Accept" link; acceptance stamps the
-- date + audit metadata and freezes a signed snapshot of the exact quote
-- agreed to. accepted_at / rejected_at / status already exist (151).

ALTER TABLE wrap_quotes
  ADD COLUMN IF NOT EXISTS approval_token UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS approval_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_approved_ip TEXT,
  ADD COLUMN IF NOT EXISTS customer_approved_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS customer_approved_via TEXT CHECK (
    customer_approved_via IS NULL
    OR customer_approved_via IN ('email_link', 'sms_link')
  ),
  ADD COLUMN IF NOT EXISTS customer_approved_delivery_target TEXT,
  ADD COLUMN IF NOT EXISTS customer_approved_time_on_page_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS customer_rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS signed_document_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS signed_document_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_wrap_quotes_approval_token
  ON wrap_quotes(approval_token)
  WHERE approval_token IS NOT NULL;

COMMENT ON COLUMN wrap_quotes.approval_token IS 'Tokenized URL for the public /approve/quote/[token] page.';
COMMENT ON COLUMN wrap_quotes.signed_document_storage_path IS 'Snapshot of the quote at acceptance time, immutable once set.';
COMMENT ON COLUMN wrap_quotes.signed_document_hash IS 'sha256 of the signed document for integrity verification.';
