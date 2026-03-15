-- ============================================
-- Fleet Check-In Tables & Storage
-- Run this in Supabase SQL Editor
-- ============================================

-- Fleet check-in records (links VIN to a sales order + proof selection)
CREATE TABLE IF NOT EXISTS fleet_checkins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vin VARCHAR(17) NOT NULL,
  vehicle_year VARCHAR(4),
  vehicle_make VARCHAR(100),
  vehicle_model VARCHAR(100),
  vehicle_trim VARCHAR(100),
  body_class VARCHAR(100),

  -- NetSuite sales order linkage
  netsuite_sales_order_id VARCHAR(50),
  sales_order_number VARCHAR(50),
  customer_name VARCHAR(255),
  sales_order_memo TEXT,
  sales_order_total DECIMAL(12,2),

  -- Graphics proof selection (stored in Supabase storage)
  proof_file_path TEXT,
  proof_file_name VARCHAR(255),
  proof_thumbnail_path TEXT,

  -- Metadata
  notes TEXT,
  status VARCHAR(20) DEFAULT 'checked_in' CHECK (status IN ('checked_in', 'in_progress', 'complete')),
  checked_in_by UUID REFERENCES auth.users(id),
  company_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Graphics proofs stored in Supabase (replaces Dropbox)
CREATE TABLE IF NOT EXISTS graphics_proofs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_name VARCHAR(255) NOT NULL,
  vehicle_type VARCHAR(255),
  file_name VARCHAR(500) NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  file_size BIGINT,
  file_type VARCHAR(50) DEFAULT 'application/pdf',
  uploaded_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_fleet_checkins_vin ON fleet_checkins(vin);
CREATE INDEX IF NOT EXISTS idx_fleet_checkins_so ON fleet_checkins(netsuite_sales_order_id);
CREATE INDEX IF NOT EXISTS idx_fleet_checkins_status ON fleet_checkins(status);
CREATE INDEX IF NOT EXISTS idx_fleet_checkins_created ON fleet_checkins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_graphics_proofs_customer ON graphics_proofs(customer_name);
CREATE INDEX IF NOT EXISTS idx_graphics_proofs_vehicle ON graphics_proofs(vehicle_type);

-- RLS Policies
ALTER TABLE fleet_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE graphics_proofs ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read all check-ins
CREATE POLICY "Users can view all fleet check-ins"
  ON fleet_checkins FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated users can insert check-ins
CREATE POLICY "Users can create fleet check-ins"
  ON fleet_checkins FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = checked_in_by);

-- Users can update their own check-ins
CREATE POLICY "Users can update own fleet check-ins"
  ON fleet_checkins FOR UPDATE
  TO authenticated
  USING (auth.uid() = checked_in_by);

-- Graphics proofs: everyone can read
CREATE POLICY "Users can view all graphics proofs"
  ON graphics_proofs FOR SELECT
  TO authenticated
  USING (true);

-- Graphics proofs: authenticated users can upload
CREATE POLICY "Users can upload graphics proofs"
  ON graphics_proofs FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = uploaded_by);

-- Create storage bucket for graphics proofs
INSERT INTO storage.buckets (id, name, public)
VALUES ('graphics-proofs', 'graphics-proofs', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for graphics-proofs bucket (unique names to avoid conflicts)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Upload graphics proofs' AND tablename = 'objects'
  ) THEN
    CREATE POLICY "Upload graphics proofs"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'graphics-proofs');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'View graphics proofs' AND tablename = 'objects'
  ) THEN
    CREATE POLICY "View graphics proofs"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'graphics-proofs');
  END IF;
END $$;
