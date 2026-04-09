-- Migration 057: File attachments for parts catalog (proofs, install guides, etc.)

CREATE TABLE IF NOT EXISTS part_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  part_id UUID NOT NULL REFERENCES netsuite_parts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  storage_path TEXT NOT NULL,
  uploaded_by UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_part_files_part ON part_files(part_id);

ALTER TABLE part_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read part files" ON part_files FOR SELECT TO authenticated USING (true);
CREATE POLICY "Internal staff can manage part files" ON part_files FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
