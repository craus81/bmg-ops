-- Migration 417: Client Files linked onto graphics jobs.
--
-- Craig (2026-10-19): "can we search fleetsuite files for file attachments
-- when inputting a graphics job? A lot of the files i need to upload come
-- from that dropbox folder." He chose to LINK them rather than copy: a
-- picked Dropbox client file (migration 379) shows on the job at once,
-- opens through /api/client-files/<id> like everywhere else, takes no extra
-- storage and always opens Dropbox's latest version.
--
-- A link is its own row, not a graphics_job_files row: those carry a
-- storage_path that the proof approval page, Download all and every other
-- reader open from storage, which a Dropbox file doesn't have.

CREATE TABLE IF NOT EXISTS graphics_job_client_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES graphics_jobs(id) ON DELETE CASCADE,
  client_file_id UUID NOT NULL REFERENCES dropbox_client_files(id) ON DELETE CASCADE,
  added_by UUID REFERENCES profiles(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, client_file_id)
);

CREATE INDEX IF NOT EXISTS idx_graphics_job_client_files_job ON graphics_job_client_files(job_id);

ALTER TABLE graphics_job_client_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Internal staff can manage graphics job client files" ON graphics_job_client_files;
CREATE POLICY "Internal staff can manage graphics job client files"
  ON graphics_job_client_files FOR ALL
  TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
