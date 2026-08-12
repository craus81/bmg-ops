-- Migration 201: part kits / packages (roadmap N4-B, Craig 2026-08-11)
--
-- A package is a FleetSuite-side TEMPLATE: a named, photographed bundle of
-- ordinary catalog parts ("Contractor Package — Transit 148"). Adding one
-- to an estimate EXPLODES it into normal item lines — the package never
-- exists as a sellable NetSuite thing, so inventory behaves exactly like
-- hand-picked lines: each member item is committed when the estimate
-- converts to a sales order and decremented when invoiced. Kits are never
-- stocked because there is no kit item to stock.
--
-- Authoring flow: build a real estimate, select the lines, "Save as
-- package". Staff author; everyone signed in can browse.

CREATE TABLE IF NOT EXISTS part_kits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  -- Freeform vehicle association for now ("Transit 148 MR") — structured
  -- fitment is N4-B2 if ever needed.
  vehicle_label TEXT,
  -- 'photos' bucket path, same convention as netsuite_parts.image_path.
  -- NULL falls back to the first member part's photo in the browser.
  image_path TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS part_kit_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kit_id UUID NOT NULL REFERENCES part_kits(id) ON DELETE CASCADE,
  part_id UUID NOT NULL REFERENCES netsuite_parts(id) ON DELETE CASCADE,
  quantity NUMERIC NOT NULL DEFAULT 1,
  sort_order INTEGER,
  UNIQUE (kit_id, part_id)
);

CREATE INDEX IF NOT EXISTS idx_part_kit_items_kit ON part_kit_items(kit_id);

COMMENT ON TABLE part_kits IS
  'Estimate package templates (N4-B): bundles of catalog parts that explode into ordinary estimate lines — never a NetSuite item, so member inventory commits/decrements per part.';

ALTER TABLE part_kits ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_kit_items ENABLE ROW LEVEL SECURITY;

-- Same posture as part_files: any signed-in user can read, internal staff manage.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can read kits' AND tablename = 'part_kits') THEN
    CREATE POLICY "Authenticated users can read kits" ON part_kits FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage kits' AND tablename = 'part_kits') THEN
    CREATE POLICY "Internal staff can manage kits" ON part_kits FOR ALL TO authenticated
      USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can read kit items' AND tablename = 'part_kit_items') THEN
    CREATE POLICY "Authenticated users can read kit items" ON part_kit_items FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage kit items' AND tablename = 'part_kit_items') THEN
    CREATE POLICY "Internal staff can manage kit items" ON part_kit_items FOR ALL TO authenticated
      USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
  END IF;
END $$;
