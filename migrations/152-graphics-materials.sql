-- Graphics material costs: what vinyl/laminate actually went into a job.
-- Install profitability landed with vendor invoices; graphics was still
-- blind — usage was never recorded, so revenue-minus-material was
-- unanswerable. Logged from the job card (prompted when a job moves past
-- printing), reported beside the installer-cost report.

CREATE TABLE IF NOT EXISTS graphics_job_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graphics_job_id UUID NOT NULL REFERENCES graphics_jobs(id) ON DELETE CASCADE,
  material_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'vinyl' CHECK (category IN ('vinyl', 'laminate', 'premask', 'other')),
  -- Either measure works; sqft is what the wrap estimator prices in.
  quantity_sqft NUMERIC(10,2),
  linear_feet NUMERIC(10,2),
  -- Total cost for this line (not per-unit).
  cost NUMERIC(10,2),
  notes TEXT,
  logged_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_graphics_job_materials_job ON graphics_job_materials(graphics_job_id);
CREATE INDEX IF NOT EXISTS idx_graphics_job_materials_name ON graphics_job_materials(material_name);

ALTER TABLE graphics_job_materials ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage graphics materials' AND tablename = 'graphics_job_materials') THEN
    CREATE POLICY "Internal staff can manage graphics materials" ON graphics_job_materials
      FOR ALL TO authenticated
      USING (public.is_internal_staff())
      WITH CHECK (public.is_internal_staff());
  END IF;
END $$;
