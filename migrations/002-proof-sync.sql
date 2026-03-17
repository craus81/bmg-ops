-- ============================================
-- Feature 2: Proof File Indexing & Auto-Sync
-- Extends graphics_proofs for NAS sync tracking
-- Run this in Supabase SQL Editor
-- ============================================

-- Add sync-related columns to graphics_proofs
ALTER TABLE graphics_proofs ADD COLUMN IF NOT EXISTS nas_path TEXT;
ALTER TABLE graphics_proofs ADD COLUMN IF NOT EXISTS nas_modified_at TIMESTAMPTZ;
ALTER TABLE graphics_proofs ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
ALTER TABLE graphics_proofs ADD COLUMN IF NOT EXISTS sync_status VARCHAR(20) DEFAULT 'synced'
  CHECK (sync_status IN ('synced', 'needs_review', 'archived', 'manual'));
ALTER TABLE graphics_proofs ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE graphics_proofs ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES auth.users(id);
ALTER TABLE graphics_proofs ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- Index for sync lookups (find by NAS path to avoid re-uploading)
CREATE INDEX IF NOT EXISTS idx_graphics_proofs_nas_path ON graphics_proofs(nas_path);

-- Index for needs_review queue
CREATE INDEX IF NOT EXISTS idx_graphics_proofs_sync_status ON graphics_proofs(sync_status);

-- Proof-to-vehicle link table
-- When a proof is matched to a fleet check-in vehicle, record the link
CREATE TABLE IF NOT EXISTS vehicle_proofs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vehicle_id UUID NOT NULL REFERENCES fleet_checkins(id) ON DELETE CASCADE,
  proof_id UUID NOT NULL REFERENCES graphics_proofs(id) ON DELETE CASCADE,
  linked_by UUID REFERENCES auth.users(id),
  linked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vehicle_id, proof_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_proofs_vehicle ON vehicle_proofs(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_proofs_proof ON vehicle_proofs(proof_id);

-- RLS for vehicle_proofs
ALTER TABLE vehicle_proofs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can view all vehicle proofs' AND tablename = 'vehicle_proofs') THEN
    CREATE POLICY "Users can view all vehicle proofs"
      ON vehicle_proofs FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can link vehicle proofs' AND tablename = 'vehicle_proofs') THEN
    CREATE POLICY "Users can link vehicle proofs"
      ON vehicle_proofs FOR INSERT TO authenticated
      WITH CHECK (true);
  END IF;
END $$;

-- Allow authenticated users to update graphics_proofs (for assigning unmatched files)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can update graphics proofs' AND tablename = 'graphics_proofs') THEN
    CREATE POLICY "Authenticated users can update graphics proofs"
      ON graphics_proofs FOR UPDATE TO authenticated USING (true);
  END IF;
END $$;
