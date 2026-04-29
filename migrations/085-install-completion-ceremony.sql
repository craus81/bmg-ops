-- Migration 085: T1.3 Install completion ceremony
--
-- Adds QC/completion fields to fleet_checkins, a configurable install
-- checklist template system, and extends the existing job_tasks stub with
-- job_type/required so it can back a per-vehicle checklist instantiated at
-- in_progress transition. Also seeds a default "mixed" install checklist.
--
-- State machine for fleet_checkins.status is now enforced at the API layer
-- in /api/vehicle-tracking/update-status: received → in_progress → complete
-- → shipped, with stuck_parts and stuck_graphics as side-branches. The
-- in_progress → complete transition requires ≥1 completion photo and all
-- required checklist items checked.

-- ═══════════ fleet_checkins completion fields ═══════════
ALTER TABLE fleet_checkins
  ADD COLUMN IF NOT EXISTS qc_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qc_completed_by UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS completion_notes TEXT;

-- ═══════════ install_checklist_templates ═══════════
CREATE TABLE IF NOT EXISTS install_checklist_templates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  install_category TEXT NOT NULL CHECK (install_category IN ('upfit', 'graphics', 'mixed')),
  -- items is ordered [{ label: string, required: boolean }]
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_install_checklist_templates_category
  ON install_checklist_templates(install_category, is_active);

ALTER TABLE install_checklist_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All staff can read install checklist templates"
  ON install_checklist_templates FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins manage install checklist templates"
  ON install_checklist_templates FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ═══════════ Activate job_tasks for fleet_checkin usage ═══════════
-- Migration 025 created job_tasks as a stub with only job_id. Add the
-- discriminator + required flag so the same table can back both fleet
-- checkin checklists and, later, graphics job task lists.
ALTER TABLE job_tasks
  ADD COLUMN IF NOT EXISTS job_type TEXT CHECK (job_type IN ('fleet_checkin', 'graphics_job')),
  ADD COLUMN IF NOT EXISTS required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES install_checklist_templates(id);

CREATE INDEX IF NOT EXISTS idx_job_tasks_type_job
  ON job_tasks(job_type, job_id);

-- ═══════════ Seed default templates ═══════════
INSERT INTO install_checklist_templates (name, install_category, items)
VALUES
  (
    'Default — Mixed Install',
    'mixed',
    '[
      {"label": "Walkaround: exterior condition documented", "required": true},
      {"label": "Interior protection in place", "required": false},
      {"label": "All panels wiped/prepped (IPA)", "required": true},
      {"label": "Graphics applied per proof", "required": true},
      {"label": "Squeegee pass complete, no lift", "required": true},
      {"label": "Premask removed", "required": false},
      {"label": "Upfit parts installed per spec", "required": true},
      {"label": "Hardware torqued to spec", "required": true},
      {"label": "Electrical connections tested", "required": false},
      {"label": "Final QC walkaround + photos", "required": true}
    ]'::jsonb
  ),
  (
    'Default — Graphics Only',
    'graphics',
    '[
      {"label": "Exterior cleaned and IPA-wiped", "required": true},
      {"label": "Graphics positioned per proof", "required": true},
      {"label": "Squeegee pass complete, no lift", "required": true},
      {"label": "Premask removed, edges sealed", "required": false},
      {"label": "Final QC walkaround + photos", "required": true}
    ]'::jsonb
  ),
  (
    'Default — Upfit Only',
    'upfit',
    '[
      {"label": "Walkaround: exterior condition documented", "required": true},
      {"label": "Interior protection in place", "required": false},
      {"label": "Upfit parts installed per spec", "required": true},
      {"label": "Hardware torqued to spec", "required": true},
      {"label": "Electrical connections tested", "required": false},
      {"label": "Final QC walkaround + photos", "required": true}
    ]'::jsonb
  )
ON CONFLICT DO NOTHING;
