-- Migration 017: Add file upload support to knowledge_docs
-- Adds columns for storing original file references alongside extracted text

ALTER TABLE knowledge_docs
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS file_type text,
  ADD COLUMN IF NOT EXISTS file_size integer,
  ADD COLUMN IF NOT EXISTS file_path text;

-- Storage bucket for knowledge base files
INSERT INTO storage.buckets (id, name, public)
VALUES ('knowledge-files', 'knowledge-files', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload to knowledge-files bucket
CREATE POLICY "Authenticated users can upload knowledge files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'knowledge-files');

-- Allow anyone to read knowledge files (for download links)
CREATE POLICY "Anyone can read knowledge files"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'knowledge-files');

-- Allow admin to delete knowledge files
CREATE POLICY "Authenticated users can delete knowledge files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'knowledge-files');
