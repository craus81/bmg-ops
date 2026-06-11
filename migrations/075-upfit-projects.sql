-- Migration 072: Upfit Projects
-- A unified project tracker that ties CRM → Estimate → Sales Order → Vendor PO → Schedule → Check-in
-- Each project represents a customer upfit job with a status pipeline and notes timeline.

CREATE TABLE IF NOT EXISTS upfit_projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Project basics
  project_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'opportunity' CHECK (status IN (
    'opportunity',    -- CRM stage: prospect is interested
    'estimate',       -- Estimate prepared or in progress
    'sold',           -- Sales order created / accepted
    'parts_ordered',  -- Vendor PO(s) placed for materials
    'scheduled',      -- Install date set
    'in_progress',    -- Vehicle(s) checked in, work underway
    'completed',      -- Work finished
    'cancelled'       -- Project cancelled
  )),

  -- Customer / CRM link
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_netsuite_id TEXT,

  -- Estimate link
  estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL,
  estimate_number TEXT,

  -- Sales Order link (NetSuite)
  netsuite_so_id TEXT,
  netsuite_so_number TEXT,

  -- Vendor PO link (NetSuite) — for ordering parts from vendor
  netsuite_vendor_po_id TEXT,
  netsuite_vendor_po_number TEXT,

  -- Schedule
  scheduled_date DATE,
  scheduled_end_date DATE,

  -- Fleet check-in link
  fleet_checkin_id UUID,

  -- Financials summary (denormalized for quick display)
  estimated_total NUMERIC(12,2),
  so_total NUMERIC(12,2),

  -- Metadata
  created_by UUID REFERENCES profiles(id),
  assigned_to UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upfit_projects_status ON upfit_projects(status);
CREATE INDEX IF NOT EXISTS idx_upfit_projects_prospect ON upfit_projects(prospect_id);
CREATE INDEX IF NOT EXISTS idx_upfit_projects_customer ON upfit_projects(customer_netsuite_id);
CREATE INDEX IF NOT EXISTS idx_upfit_projects_estimate ON upfit_projects(estimate_id);

-- Project notes / activity timeline
CREATE TABLE IF NOT EXISTS upfit_project_notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES upfit_projects(id) ON DELETE CASCADE,

  -- Note type for icon/color coding in the timeline
  note_type TEXT NOT NULL DEFAULT 'note' CHECK (note_type IN (
    'note',           -- General note
    'status_change',  -- Status pipeline change
    'estimate',       -- Estimate created/updated
    'sales_order',    -- SO created/updated
    'parts_order',    -- Vendor PO placed or updated
    'schedule',       -- Schedule set or changed
    'checkin',        -- Vehicle checked in
    'completion'      -- Work completed
  )),

  content TEXT NOT NULL,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upfit_notes_project ON upfit_project_notes(project_id);
CREATE INDEX IF NOT EXISTS idx_upfit_notes_created ON upfit_project_notes(created_at);

-- RLS policies
ALTER TABLE upfit_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE upfit_project_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "upfit_projects_select" ON upfit_projects FOR SELECT USING (true);
CREATE POLICY "upfit_projects_insert" ON upfit_projects FOR INSERT WITH CHECK (true);
CREATE POLICY "upfit_projects_update" ON upfit_projects FOR UPDATE USING (true);
CREATE POLICY "upfit_projects_delete" ON upfit_projects FOR DELETE USING (true);

CREATE POLICY "upfit_project_notes_select" ON upfit_project_notes FOR SELECT USING (true);
CREATE POLICY "upfit_project_notes_insert" ON upfit_project_notes FOR INSERT WITH CHECK (true);
CREATE POLICY "upfit_project_notes_delete" ON upfit_project_notes FOR DELETE USING (true);
