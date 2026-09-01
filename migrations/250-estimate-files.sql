-- Migration 250: Files a rep uploads onto an estimate to email the customer.
--
-- The estimate email flows (approval send, Email PDF, follow-up) all offer
-- the same attachment picker, and it reads from here: pictures, spec sheets,
-- whatever the customer needs alongside the estimate. Uploading once keeps
-- the file available on every later send instead of re-picking it from the
-- rep's phone each time.
--
-- Storage lives in R2 under the 'estimate-files' prefix (browser uploads go
-- direct via presigned PUT — /api/estimates/[id]/files), mirroring
-- prospect_files (migration 179). Rows are metadata + the public URL.

CREATE TABLE IF NOT EXISTS estimate_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT,
  size_bytes BIGINT,
  storage_path TEXT NOT NULL, -- path under the 'estimate-files' R2 prefix
  public_url TEXT NOT NULL,
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_estimate_files_estimate ON estimate_files(estimate_id);

ALTER TABLE estimate_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Internal staff can manage estimate files" ON estimate_files;
CREATE POLICY "Internal staff can manage estimate files" ON estimate_files
  FOR ALL TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
