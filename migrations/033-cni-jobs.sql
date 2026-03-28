-- CNI Jobs: Core job record for graphics installation work
-- Created by Project Coordinators, assigned to CNI installers

-- Function to generate job numbers: CNI-YYYYMMDD-XXX
CREATE OR REPLACE FUNCTION generate_cni_job_number()
RETURNS TEXT AS $$
DECLARE
  today TEXT;
  seq INT;
  job_num TEXT;
BEGIN
  today := to_char(NOW(), 'YYYYMMDD');
  SELECT COUNT(*) + 1 INTO seq
    FROM cni_jobs
    WHERE job_number LIKE 'CNI-' || today || '-%';
  job_num := 'CNI-' || today || '-' || LPAD(seq::TEXT, 3, '0');
  RETURN job_num;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS cni_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number TEXT UNIQUE NOT NULL DEFAULT generate_cni_job_number(),

  -- Job Details
  title TEXT NOT NULL,
  description TEXT,
  scope TEXT,
  assignment_type TEXT NOT NULL DEFAULT 'cni' CHECK (assignment_type IN ('internal', 'cni')),
  customer_name TEXT,
  customer_id UUID,

  -- Location
  address JSONB DEFAULT '{}'::jsonb,   -- { street, city, state, zip }
  site_contact_name TEXT,
  site_contact_phone TEXT,
  site_contact_email TEXT,

  -- VINs
  is_multi_unit BOOLEAN DEFAULT FALSE,
  vin_count INT DEFAULT 1,

  -- Budget & Timeline
  budget NUMERIC(10,2),
  deadline DATE,
  estimated_hours NUMERIC(5,1),

  -- Materials
  requires_shipment BOOLEAN DEFAULT FALSE,
  shipping_address JSONB,
  tracking_number TEXT,
  carrier TEXT,
  material_delivered BOOLEAN DEFAULT FALSE,
  material_delivered_at TIMESTAMPTZ,

  -- Files
  proof_file_paths TEXT[] DEFAULT '{}',
  design_file_paths TEXT[] DEFAULT '{}',

  -- Assignment
  assigned_installer_id UUID REFERENCES profiles(id),
  assigned_at TIMESTAMPTZ,

  -- Status (8-step flow)
  status TEXT NOT NULL DEFAULT 'awaiting_assignment' CHECK (status IN (
    'awaiting_assignment',
    'assigned_awaiting_scheduling',
    'scheduling_proposed',
    'scheduled_pending_confirmation',
    'scheduled_confirmed',
    'in_progress',
    'completed_pending_review',
    'approved_closed'
  )),

  -- Scheduling
  proposed_schedule_start DATE,
  proposed_schedule_end DATE,
  confirmed_schedule_start DATE,
  confirmed_schedule_end DATE,
  schedule_confirmed_at TIMESTAMPTZ,

  -- Completion
  completed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES profiles(id),
  closed_at TIMESTAMPTZ,

  -- Invoice (NO payment processing in app — bills created manually in NetSuite)
  invoice_status TEXT DEFAULT 'none' CHECK (invoice_status IN ('none', 'submitted', 'approved', 'billed_in_netsuite')),
  invoice_file_path TEXT,
  invoice_approved_at TIMESTAMPTZ,
  invoice_approved_by UUID REFERENCES profiles(id),
  netsuite_bill_id TEXT,

  -- Coordinator
  created_by UUID REFERENCES profiles(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cni_jobs_status ON cni_jobs(status);
CREATE INDEX IF NOT EXISTS idx_cni_jobs_assigned_installer ON cni_jobs(assigned_installer_id);
CREATE INDEX IF NOT EXISTS idx_cni_jobs_created_by ON cni_jobs(created_by);
CREATE INDEX IF NOT EXISTS idx_cni_jobs_deadline ON cni_jobs(deadline);
CREATE INDEX IF NOT EXISTS idx_cni_jobs_job_number ON cni_jobs(job_number);

-- RLS
ALTER TABLE cni_jobs ENABLE ROW LEVEL SECURITY;

-- Admin can do everything
CREATE POLICY "Admin full access to cni_jobs"
  ON cni_jobs FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND status = 'approved')
  );

-- Installers can view jobs assigned to them
CREATE POLICY "Installers can view assigned cni_jobs"
  ON cni_jobs FOR SELECT
  TO authenticated
  USING (assigned_installer_id = auth.uid());

-- Installers can update jobs assigned to them (for schedule proposals, completion, etc.)
CREATE POLICY "Installers can update assigned cni_jobs"
  ON cni_jobs FOR UPDATE
  TO authenticated
  USING (assigned_installer_id = auth.uid())
  WITH CHECK (assigned_installer_id = auth.uid());
