-- Migration 051: File attachments for graphics jobs (proofs, logos, photos, etc.)

CREATE TABLE IF NOT EXISTS graphics_job_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES graphics_jobs(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT,           -- MIME type
  file_size INTEGER,        -- bytes
  storage_path TEXT NOT NULL,
  uploaded_by UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_graphics_job_files_job ON graphics_job_files(job_id);

-- RLS
ALTER TABLE graphics_job_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can manage graphics job files"
  ON graphics_job_files FOR ALL
  TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
