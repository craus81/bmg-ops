-- Migration 019: Customer role, admin-created users, and job assignments

-- 1. Add 'customer' to the role options on profiles
-- (The role column is text, so no ALTER needed — just update constraints if any)

-- 2. Customer job assignments — admin manually assigns jobs to customer users
CREATE TABLE IF NOT EXISTS customer_job_assignments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Polymorphic: assign different job types
  job_type text NOT NULL CHECK (job_type IN ('scanned_vehicle', 'graphics_job', 'purchase_order')),
  job_id uuid NOT NULL,
  assigned_by uuid REFERENCES profiles(id),
  assigned_at timestamptz DEFAULT now(),
  -- Unique constraint: prevent duplicate assignments
  UNIQUE(customer_user_id, job_type, job_id)
);

CREATE INDEX IF NOT EXISTS idx_cja_customer ON customer_job_assignments(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_cja_job ON customer_job_assignments(job_type, job_id);

-- RLS
ALTER TABLE customer_job_assignments ENABLE ROW LEVEL SECURITY;

-- Admin can manage all assignments
CREATE POLICY "Admin can manage job assignments"
  ON customer_job_assignments FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Customer users can read their own assignments
CREATE POLICY "Customer can read own assignments"
  ON customer_job_assignments FOR SELECT
  TO authenticated
  USING (customer_user_id = auth.uid());

-- 3. Customer approval tracking on jobs
ALTER TABLE scanned_vehicles
  ADD COLUMN IF NOT EXISTS customer_approved boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_approved_by uuid REFERENCES profiles(id);

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS customer_approved boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_approved_by uuid REFERENCES profiles(id);

-- 4. Allow customer role users to read scanned_vehicles and graphics_jobs they're assigned to
CREATE POLICY "Customer can read assigned vehicles"
  ON scanned_vehicles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
      AND cja.job_type = 'scanned_vehicle'
      AND cja.job_id = scanned_vehicles.id
    )
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'installer', 'production', 'sales')
    )
  );

CREATE POLICY "Customer can read assigned graphics jobs"
  ON graphics_jobs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
      AND cja.job_type = 'graphics_job'
      AND cja.job_id = graphics_jobs.id
    )
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'installer', 'production', 'sales')
    )
  );

-- Allow customer to update approval fields on their assigned jobs
CREATE POLICY "Customer can approve assigned vehicles"
  ON scanned_vehicles FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
      AND cja.job_type = 'scanned_vehicle'
      AND cja.job_id = scanned_vehicles.id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
      AND cja.job_type = 'scanned_vehicle'
      AND cja.job_id = scanned_vehicles.id
    )
  );

CREATE POLICY "Customer can approve assigned graphics jobs"
  ON graphics_jobs FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
      AND cja.job_type = 'graphics_job'
      AND cja.job_id = graphics_jobs.id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
      AND cja.job_type = 'graphics_job'
      AND cja.job_id = graphics_jobs.id
    )
  );
