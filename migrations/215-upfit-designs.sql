-- Migration 215: upfit_designs — saved 3D upfit layouts (configurator phase 2)
--
-- Craig 2026-08-20: a rep designs a van in the 3D upfit designer and the
-- design has to survive: reload it, refine it with the customer, turn it
-- into an estimate. One row per design; the layout itself is a versioned
-- JSONB snapshot (same philosophy as wrap_quotes.measurements — geometry
-- in one coordinate space, real-world inches as the source of truth,
-- catalog facts snapshotted at placement so later catalog edits can't
-- silently change a saved design).
--
-- Trade packages are template rows in THIS table (is_template + trade),
-- not part_kits: a configurator package must carry 3D positions, which
-- part_kit_items has no notion of. Applying a template clones its layout
-- into a new design. part_kits stay what they are — flat parts bundles —
-- and remain usable in the designer via auto-arrange.

CREATE TABLE IF NOT EXISTS upfit_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  platform_id UUID NOT NULL REFERENCES vehicle_platforms(id),
  wheelbase_label TEXT NOT NULL,
  roof_label TEXT NOT NULL DEFAULT '',
  interior_id UUID REFERENCES vehicle_interiors(id) ON DELETE SET NULL,
  layout JSONB NOT NULL DEFAULT '{"version":1,"units":"in","items":[],"unplaced":[]}'::jsonb,
  is_template BOOLEAN NOT NULL DEFAULT false,
  trade TEXT,                     -- templates only: 'electrical', 'delivery', … (TRADES in src/lib/upfit-layout.ts gates the picker)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'quoted', 'archived')),
  snapshot_path TEXT,             -- R2 'photos' bucket, upfit-designs/ prefix — the 3D capture for thumbnails & the PDF
  estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_upfit_designs_platform ON upfit_designs(platform_id);
CREATE INDEX IF NOT EXISTS idx_upfit_designs_templates ON upfit_designs(platform_id, trade) WHERE is_template;
CREATE INDEX IF NOT EXISTS idx_upfit_designs_estimate ON upfit_designs(estimate_id) WHERE estimate_id IS NOT NULL;

COMMENT ON TABLE upfit_designs IS '3D upfit designer layouts. is_template=true rows are the trade packages offered in step 2; applying one clones its layout.';
COMMENT ON COLUMN upfit_designs.layout IS 'Versioned JSONB: placed items (part snapshot + position/rotation/zone, inches) and an unplaced list for parts without dimensions. Shape defined in src/lib/upfit-layout.ts.';

ALTER TABLE upfit_designs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can read upfit designs' AND tablename = 'upfit_designs') THEN
    CREATE POLICY "Authenticated users can read upfit designs" ON upfit_designs FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage upfit designs' AND tablename = 'upfit_designs') THEN
    CREATE POLICY "Internal staff can manage upfit designs" ON upfit_designs FOR ALL TO authenticated
      USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
  END IF;
END $$;
