-- Migration 190: Optional completion photos on scans (K8)
--
-- The Aug 6 meeting asked for OPTIONAL completion photos in the field
-- scanner — explicitly zero extra taps when skipped. One row per photo,
-- attached to the scan_logs row(s) the capture created (a multi-part scan
-- attaches the same photo to each part's row so every Scan Log line shows
-- it). Files live on R2 under the 'photos' prefix like vehicle_photos.
--
-- Writes go through /api/scans/photos (service role) because field/CNI
-- installers are not internal staff; reads are internal-staff RLS like
-- scan_logs itself.

CREATE TABLE IF NOT EXISTS scan_photos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  scan_log_id uuid NOT NULL REFERENCES scan_logs(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  content_type text,
  taken_by uuid REFERENCES profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_photos_scan ON scan_photos(scan_log_id);

ALTER TABLE scan_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Internal staff can manage scan photos" ON scan_photos;
CREATE POLICY "Internal staff can manage scan photos" ON scan_photos
  FOR ALL TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
