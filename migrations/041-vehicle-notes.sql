-- Vehicle install notes (running log per vehicle)
CREATE TABLE IF NOT EXISTS vehicle_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id UUID NOT NULL REFERENCES fleet_checkins(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  created_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_vehicle_notes_vehicle ON vehicle_notes(vehicle_id);

-- RLS
ALTER TABLE vehicle_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can view vehicle notes"
  ON vehicle_notes FOR SELECT
  USING (auth.uid() IN (SELECT id FROM profiles WHERE role IN ('admin','installer','staff')));

CREATE POLICY "Internal staff can insert vehicle notes"
  ON vehicle_notes FOR INSERT
  WITH CHECK (auth.uid() IN (SELECT id FROM profiles WHERE role IN ('admin','installer','staff')));

CREATE POLICY "Users can delete their own notes"
  ON vehicle_notes FOR DELETE
  USING (auth.uid() = created_by);
