-- Graphics Production Dashboard
-- Tracks graphic jobs through the production pipeline

-- ═══════════ GRAPHICS JOBS TABLE ═══════════
CREATE TABLE IF NOT EXISTS graphics_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Source: linked to PO or free-form
  po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  po_line_item_id UUID REFERENCES po_line_items(id) ON DELETE SET NULL,

  -- Job info
  job_number TEXT, -- auto-generated or manual
  title TEXT NOT NULL, -- e.g. "GRAPHIC KIT-FORD TRANSIT" or free-form title
  part_number TEXT, -- the 02/RM part number if from PO
  customer TEXT, -- Masterack or other customer
  quantity INT DEFAULT 1,

  -- Content details (unit numbers, addresses, custom text per unit)
  content TEXT, -- free-text field for unit-specific info (unit numbers, addresses, etc.)
  notes TEXT, -- internal production notes

  -- Vinyl specifications
  vinyl_type TEXT, -- e.g. "3M IJ180Cv3", "Avery MPI 1105"
  vinyl_color TEXT, -- e.g. "White", "Black", "Custom"
  laminate TEXT, -- e.g. "3M 8518", "Gloss", "Matte"
  print_method TEXT, -- e.g. "Solvent", "Latex", "UV"
  cut_method TEXT, -- e.g. "Contour cut", "Kiss cut", "Die cut"
  premask TEXT, -- e.g. "R-Tape 4075", "Clear", "Paper"

  -- Status pipeline
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN (
    'flagged',       -- auto-detected from PO, waiting for admin review
    'received',      -- job confirmed/created
    'designing',     -- in design phase
    'revision',      -- design revision requested
    'printing',      -- on the printer
    'outgassing',    -- drying/outgassing period
    'cutting',       -- cutting phase
    'packing',       -- being packed
    'ready',         -- ready to install or ship
    'shipped',       -- shipped out
    'installed',     -- installed on vehicle
    'cancelled'      -- cancelled
  )),

  -- Shipping/tracking
  tracking_number TEXT,
  carrier TEXT, -- e.g. "UPS", "FedEx", "LTL"
  ship_to TEXT, -- shipping destination

  -- Priority
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'rush')),
  due_date DATE,

  -- Metadata
  created_by UUID REFERENCES auth.users(id),
  assigned_to UUID REFERENCES auth.users(id), -- production team member
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_graphics_jobs_status ON graphics_jobs(status);
CREATE INDEX IF NOT EXISTS idx_graphics_jobs_po ON graphics_jobs(po_id);
CREATE INDEX IF NOT EXISTS idx_graphics_jobs_created ON graphics_jobs(created_at DESC);

-- ═══════════ GRAPHICS STATUS HISTORY ═══════════
CREATE TABLE IF NOT EXISTS graphics_status_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES graphics_jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by UUID REFERENCES auth.users(id),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_graphics_history_job ON graphics_status_history(job_id);

-- ═══════════ NOTIFICATION PREFERENCES ═══════════
CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Graphics job notifications
  notify_new_job BOOLEAN DEFAULT true,
  notify_status_change BOOLEAN DEFAULT true,
  notify_ready BOOLEAN DEFAULT true,
  notify_shipped BOOLEAN DEFAULT true,
  -- Delivery methods
  notify_in_app BOOLEAN DEFAULT true,
  notify_email BOOLEAN DEFAULT false,
  notify_sms BOOLEAN DEFAULT false,
  phone_number TEXT, -- for SMS notifications
  -- Specific statuses to be notified about (null = use defaults above)
  custom_statuses TEXT[], -- array of status values to notify on
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ═══════════ UPDATE PROFILES ROLE CHECK ═══════════
-- Add 'production' as valid role
-- Note: if role is enforced by a CHECK constraint, you may need to drop/recreate it.
-- If no CHECK constraint exists, this is just for documentation.
-- The app code will handle the new role value.

-- ═══════════ RLS POLICIES ═══════════
ALTER TABLE graphics_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE graphics_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- Graphics jobs: admins and production can see all, others see nothing
CREATE POLICY graphics_jobs_select ON graphics_jobs FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'production') AND status = 'approved')
  );

CREATE POLICY graphics_jobs_insert ON graphics_jobs FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'production') AND status = 'approved')
  );

CREATE POLICY graphics_jobs_update ON graphics_jobs FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'production') AND status = 'approved')
  );

CREATE POLICY graphics_jobs_delete ON graphics_jobs FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND status = 'approved')
  );

-- Status history: same as jobs
CREATE POLICY graphics_history_select ON graphics_status_history FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'production') AND status = 'approved')
  );

CREATE POLICY graphics_history_insert ON graphics_status_history FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'production') AND status = 'approved')
  );

-- Notification preferences: users can manage their own
CREATE POLICY notif_prefs_select ON notification_preferences FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY notif_prefs_insert ON notification_preferences FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY notif_prefs_update ON notification_preferences FOR UPDATE
  USING (user_id = auth.uid());
