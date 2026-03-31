-- Migration 042: Vehicle Photos for In-Shop Tracking
-- Completion photos and other photo documentation per vehicle

CREATE TABLE IF NOT EXISTS vehicle_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id UUID NOT NULL REFERENCES fleet_checkins(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  photo_type TEXT NOT NULL DEFAULT 'completion' CHECK (
    photo_type IN ('completion', 'before', 'during', 'damage', 'other')
  ),
  taken_by UUID REFERENCES auth.users(id),
  taken_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_vehicle_photos_vehicle ON vehicle_photos(vehicle_id);

-- RLS
ALTER TABLE vehicle_photos ENABLE ROW LEVEL SECURITY;

-- All internal staff can view photos
CREATE POLICY "staff_read_vehicle_photos" ON vehicle_photos
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IS NOT NULL)
  );

-- All internal staff can upload photos
CREATE POLICY "staff_insert_vehicle_photos" ON vehicle_photos
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IS NOT NULL)
  );

-- Users can delete their own photos, admins can delete any
CREATE POLICY "own_or_admin_delete_vehicle_photos" ON vehicle_photos
  FOR DELETE USING (
    taken_by = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)))
  );
