-- Part allocations: FleetSuite-side reservations of on-hand stock to a
-- specific upfit project — "these 3 shelving units are for the Anderson
-- build." Readiness math subtracts other projects' reservations, so two
-- jobs can't count the same shelf stock. One row per (project, part);
-- adjust the quantity rather than stacking rows.

CREATE TABLE IF NOT EXISTS part_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES upfit_projects(id) ON DELETE CASCADE,
  item_number TEXT NOT NULL,          -- normalized (last ":" segment, uppercased)
  quantity NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  -- reserved: active hold · consumed: project completed, parts used ·
  -- released: freed manually or project cancelled
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'consumed', 'released')),
  note TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  UNIQUE (project_id, item_number)
);

CREATE INDEX IF NOT EXISTS idx_part_allocations_item
  ON part_allocations(item_number) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_part_allocations_project
  ON part_allocations(project_id);

ALTER TABLE part_allocations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff manage part allocations' AND tablename = 'part_allocations') THEN
    CREATE POLICY "Staff manage part allocations" ON part_allocations
      FOR ALL TO authenticated
      USING (public.is_internal_staff())
      WITH CHECK (public.is_internal_staff());
  END IF;
END $$;
