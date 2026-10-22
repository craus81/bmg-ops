-- Migration 424: who answered an estimate, and download links that last.
--
-- Craig (2026-10-21, thread "Estimate email attachment and approval link"):
-- customers replied to the approval email instead of pressing Review &
-- Approve, so the approval email stops attaching the PDF. Two things follow:
--
-- 1. Each recipient now gets their own email and link (?to=…&own=1), the
--    way proof emails work since migration 388. customer_responder records
--    who answered: the link's address, or the name a forwarded reader typed.
--
-- 2. Without an attachment the email's download links are the customer's
--    only copy, so they must outlive the 30-day approval link and survive a
--    resend (which rotates approval_token). Every send records its token
--    here, with the files it carried, good for downloads for a year.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS customer_responder TEXT;

CREATE TABLE IF NOT EXISTS estimate_download_tokens (
  token TEXT PRIMARY KEY,
  estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  file_ids UUID[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_estimate_download_tokens_estimate
  ON estimate_download_tokens (estimate_id);

-- Read only by the service-role download routes; no client access.
ALTER TABLE estimate_download_tokens ENABLE ROW LEVEL SECURITY;

-- One email per person means one Resend message id per person; the bounce
-- webhook matches any of them (approval_email_id keeps the first).
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_email_ids TEXT[];
CREATE INDEX IF NOT EXISTS idx_estimates_approval_email_ids
  ON estimates USING GIN (approval_email_ids);
