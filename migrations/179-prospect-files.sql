-- Migration 179: Files attached to a CRM/customer record.
--
-- Storage lives in R2 under the 'prospect-files' prefix (browser uploads go
-- direct via presigned PUT — /api/prospects/files). Rows are metadata + the
-- public URL, mirroring how graphics invoice PDFs are stored.

CREATE TABLE IF NOT EXISTS prospect_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT,
  size_bytes BIGINT,
  storage_path TEXT NOT NULL, -- path under the 'prospect-files' R2 prefix
  public_url TEXT NOT NULL,
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospect_files_prospect ON prospect_files(prospect_id);

ALTER TABLE prospect_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Internal staff can manage prospect files" ON prospect_files
  FOR ALL TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
