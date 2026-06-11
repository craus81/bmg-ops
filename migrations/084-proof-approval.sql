-- Migration 078: T1.8 Magic-link graphic proof approval
--
-- customer_approved, customer_approved_at, customer_approved_by already
-- exist on graphics_jobs (migration 019). This migration adds the rest
-- of the T1.7-style approval/audit schema (tokenized link, full E-SIGN
-- metadata, signed-document fields) so the same tokenized approval
-- pattern works for graphic proofs.

ALTER TABLE graphics_jobs
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
  ADD COLUMN IF NOT EXISTS customer_rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS signed_document_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS signed_document_hash TEXT,
  ADD COLUMN IF NOT EXISTS signed_proof_storage_paths TEXT[],
  ADD COLUMN IF NOT EXISTS sent_for_approval_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_for_approval_by UUID REFERENCES profiles(id);

CREATE INDEX IF NOT EXISTS idx_graphics_jobs_approval_token
  ON graphics_jobs(approval_token)
  WHERE approval_token IS NOT NULL;

COMMENT ON COLUMN graphics_jobs.approval_token IS 'Tokenized URL for the public /approve/proof/[token] page.';
COMMENT ON COLUMN graphics_jobs.signed_proof_storage_paths IS 'Cloned proof files at approval time, immutable once set. Array because a job can have multiple design files.';
COMMENT ON COLUMN graphics_jobs.signed_document_storage_path IS 'HTML audit snapshot of the proof approval with E-SIGN metadata.';

-- Add 'revision' to GRAPHICS_STATUS if not already present (it's in the
-- existing enum per src/lib/types.ts GRAPHICS_STATUS_ORDER — this is a
-- no-op for the CHECK constraint but documents the status flow for
-- customer rejection.)
