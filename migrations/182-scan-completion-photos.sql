-- Migration 182: Completion photos for vehicle scans
--
-- Field techs and CNI installers get an option to attach completion photos
-- when they scan a vehicle into the system. Each photo hangs off the
-- scan_logs record (the job record for a field install) and denormalizes
-- part_number + VIN at insert time, so the same photo is also searchable
-- from the parts catalog — like a proof or schematic, but showing the part
-- actually installed on a vehicle.

CREATE TABLE IF NOT EXISTS scan_photos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scan_log_id UUID NOT NULL REFERENCES scan_logs(id) ON DELETE CASCADE,
  -- Denormalized from the scan_logs row server-side at insert, so the
  -- part-level gallery never needs a join back through scan_logs (and a
  -- later edit to the scan's part doesn't silently orphan the photos).
  part_number TEXT,
  vin TEXT,
  storage_path TEXT NOT NULL,  -- object key in the 'photos' bucket
  file_name TEXT,
  photo_type TEXT NOT NULL DEFAULT 'completion' CHECK (
    photo_type IN ('completion', 'before', 'during', 'other')
  ),
  uploaded_by UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_photos_scan ON scan_photos(scan_log_id);
CREATE INDEX IF NOT EXISTS idx_scan_photos_part ON scan_photos(upper(part_number));

ALTER TABLE scan_photos ENABLE ROW LEVEL SECURITY;

-- Reads: internal staff see everything; CNI installers see what they took.
-- Writes go through /api/scans/photos with the service role — installers
-- can't write scan_logs directly and the same holds for its photos, so
-- ownership/path checks live in the API rather than in policies.
CREATE POLICY "staff_or_own_read_scan_photos" ON scan_photos
  FOR SELECT USING (
    public.is_internal_staff() OR uploaded_by = auth.uid()
  );
