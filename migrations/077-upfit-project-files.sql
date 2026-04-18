-- Migration 077: File attachments for upfit projects (photos & supporting docs)
-- Files themselves live in R2 under the `upfit-files` bucket prefix; R2 doesn't
-- require a pre-provisioned bucket so no storage.buckets insert is needed.

CREATE TABLE IF NOT EXISTS upfit_project_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES upfit_projects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  storage_path TEXT NOT NULL,
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upfit_project_files_project ON upfit_project_files(project_id);

ALTER TABLE upfit_project_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "upfit_project_files_all" ON upfit_project_files FOR ALL USING (true) WITH CHECK (true);
