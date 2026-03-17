-- ============================================
-- Feature 1: Vehicle Tracking — Monday.com Replacement
-- Creates fleet_checkins + vehicle_status_history
-- Run this in Supabase SQL Editor (single script)
-- ============================================


-- ╔══════════════════════════════════════════╗
-- ║  PART A — Base Tables (from setup file)  ║
-- ╚══════════════════════════════════════════╝

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
  status VARCHAR(20) DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'stuck_parts', 'stuck_graphics', 'complete', 'shipped', 'checked_in')),
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

-- RLS for base tables
ALTER TABLE fleet_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE graphics_proofs ENABLE ROW LEVEL SECURITY;

-- fleet_checkins policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can view all fleet check-ins' AND tablename = 'fleet_checkins') THEN
    CREATE POLICY "Users can view all fleet check-ins"
      ON fleet_checkins FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can create fleet check-ins' AND tablename = 'fleet_checkins') THEN
    CREATE POLICY "Users can create fleet check-ins"
      ON fleet_checkins FOR INSERT TO authenticated
      WITH CHECK (auth.uid() = checked_in_by);
  END IF;
END $$;

-- graphics_proofs policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can view all graphics proofs' AND tablename = 'graphics_proofs') THEN
    CREATE POLICY "Users can view all graphics proofs"
      ON graphics_proofs FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can upload graphics proofs' AND tablename = 'graphics_proofs') THEN
    CREATE POLICY "Users can upload graphics proofs"
      ON graphics_proofs FOR INSERT TO authenticated
      WITH CHECK (auth.uid() = uploaded_by);
  END IF;
END $$;

-- Storage bucket for graphics proofs
INSERT INTO storage.buckets (id, name, public)
VALUES ('graphics-proofs', 'graphics-proofs', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Upload graphics proofs' AND tablename = 'objects') THEN
    CREATE POLICY "Upload graphics proofs"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'graphics-proofs');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'View graphics proofs' AND tablename = 'objects') THEN
    CREATE POLICY "View graphics proofs"
      ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'graphics-proofs');
  END IF;
END $$;


-- ╔══════════════════════════════════════════╗
-- ║  PART B — Vehicle Tracking Extensions    ║
-- ╚══════════════════════════════════════════╝

-- Expand status constraint (safe if already correct from CREATE above)
ALTER TABLE fleet_checkins DROP CONSTRAINT IF EXISTS fleet_checkins_status_check;
ALTER TABLE fleet_checkins ADD CONSTRAINT fleet_checkins_status_check
  CHECK (status IN ('received', 'in_progress', 'stuck_parts', 'stuck_graphics', 'complete', 'shipped', 'checked_in'));

-- Migrate any old 'checked_in' records to 'received'
UPDATE fleet_checkins SET status = 'received' WHERE status = 'checked_in';

-- Add assigned_to column for job assignment
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES auth.users(id);

-- Add customer_portal_token for future customer portal access
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS customer_portal_token VARCHAR(64) UNIQUE;

-- Vehicle status history — tracks every status change with optional note
CREATE TABLE IF NOT EXISTS vehicle_status_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vehicle_id UUID NOT NULL REFERENCES fleet_checkins(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  note TEXT,
  changed_by UUID NOT NULL REFERENCES auth.users(id),
  changed_by_name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for vehicle_status_history
CREATE INDEX IF NOT EXISTS idx_vsh_vehicle_id ON vehicle_status_history(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vsh_created_at ON vehicle_status_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vsh_changed_by ON vehicle_status_history(changed_by);

-- Index for new fleet_checkins columns
CREATE INDEX IF NOT EXISTS idx_fleet_checkins_assigned ON fleet_checkins(assigned_to);
CREATE INDEX IF NOT EXISTS idx_fleet_checkins_portal_token ON fleet_checkins(customer_portal_token);

-- RLS for vehicle_status_history
ALTER TABLE vehicle_status_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can view all status history' AND tablename = 'vehicle_status_history') THEN
    CREATE POLICY "Users can view all status history"
      ON vehicle_status_history FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can create status history' AND tablename = 'vehicle_status_history') THEN
    CREATE POLICY "Users can create status history"
      ON vehicle_status_history FOR INSERT TO authenticated
      WITH CHECK (auth.uid() = changed_by);
  END IF;
END $$;

-- Update policy: allow any authenticated user to update fleet check-ins
-- (app-level role checks handle admin-only restrictions)
DROP POLICY IF EXISTS "Users can update own fleet check-ins" ON fleet_checkins;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can update fleet check-ins' AND tablename = 'fleet_checkins') THEN
    CREATE POLICY "Authenticated users can update fleet check-ins"
      ON fleet_checkins FOR UPDATE TO authenticated USING (true);
  END IF;
END $$;

-- Auto-set updated_at on fleet_checkins changes
CREATE OR REPLACE FUNCTION update_fleet_checkins_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fleet_checkins_updated_at ON fleet_checkins;
CREATE TRIGGER fleet_checkins_updated_at
  BEFORE UPDATE ON fleet_checkins
  FOR EACH ROW
  EXECUTE FUNCTION update_fleet_checkins_updated_at();

-- Auto-generate portal token on insert
CREATE OR REPLACE FUNCTION generate_portal_token()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.customer_portal_token IS NULL THEN
    NEW.customer_portal_token = encode(gen_random_bytes(32), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fleet_checkins_portal_token ON fleet_checkins;
CREATE TRIGGER fleet_checkins_portal_token
  BEFORE INSERT ON fleet_checkins
  FOR EACH ROW
  EXECUTE FUNCTION generate_portal_token();
