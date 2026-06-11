-- Migration 077: T1.7 Magic-link estimate approval
--
-- Adds approval/rejection tracking + E-SIGN Act-grade audit metadata to
-- estimates so a tokenized public page can capture customer acceptance
-- without requiring a signed-in session. A snapshot of the estimate
-- document at the moment of approval is stored separately (see
-- signed_document_storage_path + signed_document_hash) so future edits
-- to the estimate don't alter the record of what was agreed to.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS approval_token UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS approval_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_approved BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_approved_ip TEXT,
  ADD COLUMN IF NOT EXISTS customer_approved_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS customer_approved_via TEXT CHECK (
    customer_approved_via IS NULL
    OR customer_approved_via IN ('email_link', 'sms_link')
  ),
  ADD COLUMN IF NOT EXISTS customer_approved_delivery_target TEXT,
  ADD COLUMN IF NOT EXISTS customer_approved_time_on_page_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS customer_rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS signed_document_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS signed_document_hash TEXT,
  ADD COLUMN IF NOT EXISTS sent_for_approval_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_for_approval_by UUID REFERENCES profiles(id);

CREATE INDEX IF NOT EXISTS idx_estimates_approval_token
  ON estimates(approval_token)
  WHERE approval_token IS NOT NULL;

COMMENT ON COLUMN estimates.approval_token IS 'Tokenized URL for the public /approve/estimate/[token] page.';
COMMENT ON COLUMN estimates.customer_approved_via IS 'Which channel delivered the approval link.';
COMMENT ON COLUMN estimates.signed_document_storage_path IS 'Snapshot of the estimate at approval time, immutable once set.';
COMMENT ON COLUMN estimates.signed_document_hash IS 'sha256 of the signed document for integrity verification.';

-- Rate-limit table for the public approval endpoint (per-IP attempts per hour)
CREATE TABLE IF NOT EXISTS approval_rate_limits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ip_address TEXT NOT NULL,
  action TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_rate_limits_ip_action_time
  ON approval_rate_limits(ip_address, action, attempted_at DESC);

-- RLS: only admins/service role can read rate-limit history; no direct UI
ALTER TABLE approval_rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read approval_rate_limits"
  ON approval_rate_limits FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- Storage bucket for signed documents (private; only the service role reads/writes)
INSERT INTO storage.buckets (id, name, public)
VALUES ('signed-documents', 'signed-documents', false)
ON CONFLICT (id) DO NOTHING;
