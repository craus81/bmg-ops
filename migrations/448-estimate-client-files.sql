-- Migration 448: Client Files linked onto estimates.
--
-- Craig (2026-10-28): in split screen, drag a Client Files file across and
-- drop it on an estimate. He chose to LINK it, the way graphics jobs do
-- (migration 417), not copy it into the estimate's Pictures & files
-- (estimate_files): it opens Dropbox's latest version through
-- /api/client-files/<id> and takes no extra storage.

CREATE TABLE IF NOT EXISTS estimate_client_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  client_file_id UUID NOT NULL REFERENCES dropbox_client_files(id) ON DELETE CASCADE,
  added_by UUID REFERENCES profiles(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (estimate_id, client_file_id)
);

CREATE INDEX IF NOT EXISTS idx_estimate_client_files_estimate ON estimate_client_files(estimate_id);

ALTER TABLE estimate_client_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Internal staff can manage estimate client files" ON estimate_client_files;
CREATE POLICY "Internal staff can manage estimate client files"
  ON estimate_client_files FOR ALL
  TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
