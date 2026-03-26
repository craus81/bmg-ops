-- Migration 030: Calendar feature
-- Adds: outside_installers table, installer_appointments table
-- Adds: due_date, production_schedule_date, calendar_event_id columns to fleet_checkins

-- ─── Outside installer subcontractors ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS outside_installers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  company_name TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE outside_installers ENABLE ROW LEVEL SECURITY;

-- Admin full access
CREATE POLICY "admin_all_outside_installers" ON outside_installers
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Internal staff read
CREATE POLICY "internal_read_outside_installers" ON outside_installers
  FOR SELECT USING (is_internal_staff());

-- ─── Installer appointments ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS installer_appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outside_installer_id UUID NOT NULL REFERENCES outside_installers(id) ON DELETE CASCADE,
  graphics_job_id UUID REFERENCES graphics_jobs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  scheduled_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled')),
  calendar_event_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE installer_appointments ENABLE ROW LEVEL SECURITY;

-- Admin full access
CREATE POLICY "admin_all_installer_appointments" ON installer_appointments
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Internal staff read
CREATE POLICY "internal_read_installer_appointments" ON installer_appointments
  FOR SELECT USING (is_internal_staff());

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_installer_appointment_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_installer_appointment_updated_at
  BEFORE UPDATE ON installer_appointments
  FOR EACH ROW EXECUTE FUNCTION update_installer_appointment_updated_at();

-- ─── fleet_checkins additions ─────────────────────────────────────────────────

-- due_date: shown on check-in record only, not on calendar
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS due_date DATE;

-- production_schedule_date: synced to Google Calendar as green event
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS production_schedule_date DATE;

-- calendar_event_id: stores Google Calendar event ID for production_schedule_date
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
