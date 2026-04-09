-- Migration 056: Locations and billable customer for unified scan flow

-- Work locations where installs happen
CREATE TABLE IF NOT EXISTS work_locations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed known locations
INSERT INTO work_locations (name, city, state) VALUES
  ('Masterack - Wentzville', 'Wentzville', 'MO'),
  ('Masterack - Kansas City', 'Kansas City', 'MO'),
  ('Masterack - Social Circle', 'Social Circle', 'GA'),
  ('National Fleet', NULL, NULL),
  ('BMG Shop', NULL, NULL)
ON CONFLICT DO NOTHING;

-- Add billable customer to parts catalog
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS billable_customer TEXT;

-- Scan logs — every VIN scanned by any user
CREATE TABLE IF NOT EXISTS scan_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vin VARCHAR(17) NOT NULL,
  vehicle_year VARCHAR(4),
  vehicle_make VARCHAR(100),
  vehicle_model VARCHAR(100),
  vehicle_trim VARCHAR(100),
  body_class VARCHAR(100),
  -- What was being installed
  part_number TEXT,
  part_description TEXT,
  billable_customer TEXT,
  -- Where
  location_id UUID REFERENCES work_locations(id),
  location_name TEXT,
  -- PO matching (filled by admin or auto-match)
  po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  po_number TEXT,
  po_line_item_id UUID REFERENCES po_line_items(id) ON DELETE SET NULL,
  -- Who and when
  scanned_by UUID REFERENCES profiles(id),
  scanned_at TIMESTAMPTZ DEFAULT now(),
  -- Export/archive
  exported_at TIMESTAMPTZ,
  exported_by UUID REFERENCES profiles(id),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scan_logs_vin ON scan_logs(vin);
CREATE INDEX IF NOT EXISTS idx_scan_logs_part ON scan_logs(part_number);
CREATE INDEX IF NOT EXISTS idx_scan_logs_location ON scan_logs(location_id);
CREATE INDEX IF NOT EXISTS idx_scan_logs_po ON scan_logs(po_id);
CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned ON scan_logs(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_logs_exported ON scan_logs(exported_at) WHERE exported_at IS NULL;

-- RLS
ALTER TABLE work_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read locations" ON work_locations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admin can manage locations" ON work_locations FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "Internal staff can manage scan logs" ON scan_logs FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
