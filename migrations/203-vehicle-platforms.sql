-- Migration 203: vehicle platforms + part fitment (N4-B2 phase 1)
--
-- Craig 2026-08-11: quote by vehicle, Ranger-style — pick the vehicle,
-- see only what fits. This is the vocabulary + the join. Platforms are
-- seeded from BMG's actual mix (Craig's list) and mirror how Ranger
-- groups them (Express/Savana as one platform). Fitment rows carry
-- optional wheelbase/roof qualifiers (NULL = fits the whole platform)
-- and a source, so vendor-crawled and description-derived tags can be
-- told apart from human ones. VIN-driven resolution is phase 2.

CREATE TABLE IF NOT EXISTS vehicle_platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,          -- stable code: 'transit', 'promaster-city'
  label TEXT NOT NULL,               -- display: 'Ford Transit'
  body_type TEXT NOT NULL DEFAULT 'van' CHECK (body_type IN ('van', 'truck', 'other')),
  image_path TEXT,                   -- vehicle card photo ('photos' bucket), later
  sort_order INTEGER NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS part_fitment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id UUID NOT NULL REFERENCES netsuite_parts(id) ON DELETE CASCADE,
  platform_id UUID NOT NULL REFERENCES vehicle_platforms(id) ON DELETE CASCADE,
  -- Optional qualifiers; NULL = any. Freeform-but-conventional labels for
  -- now ('148', '148 EL', 'high') — structured fitment specs come with
  -- the VIN work.
  wheelbase_label TEXT,
  roof_label TEXT,
  source TEXT NOT NULL CHECK (source IN ('description', 'vendor_site', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES profiles(id)
);

-- One row per distinct (part, platform, qualifiers) — NULLs coalesced so
-- re-running the auto-tagger is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_part_fitment
  ON part_fitment (part_id, platform_id, COALESCE(wheelbase_label, ''), COALESCE(roof_label, ''));
CREATE INDEX IF NOT EXISTS idx_part_fitment_platform ON part_fitment(platform_id);
CREATE INDEX IF NOT EXISTS idx_part_fitment_part ON part_fitment(part_id);

ALTER TABLE vehicle_platforms ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_fitment ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can read platforms' AND tablename = 'vehicle_platforms') THEN
    CREATE POLICY "Authenticated users can read platforms" ON vehicle_platforms FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage platforms' AND tablename = 'vehicle_platforms') THEN
    CREATE POLICY "Internal staff can manage platforms" ON vehicle_platforms FOR ALL TO authenticated
      USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can read fitment' AND tablename = 'part_fitment') THEN
    CREATE POLICY "Authenticated users can read fitment" ON part_fitment FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage fitment' AND tablename = 'part_fitment') THEN
    CREATE POLICY "Internal staff can manage fitment" ON part_fitment FOR ALL TO authenticated
      USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
  END IF;
END $$;

-- Seed: BMG's platform mix (Craig 2026-08-11), Ranger-style grouping.
INSERT INTO vehicle_platforms (key, label, body_type, sort_order) VALUES
  ('transit',              'Ford Transit',                     'van',   10),
  ('transit-connect',      'Ford Transit Connect',             'van',   20),
  ('promaster',            'Ram ProMaster',                    'van',   30),
  ('promaster-city',       'Ram ProMaster City',               'van',   40),
  ('sprinter',             'Mercedes-Benz Sprinter',           'van',   50),
  ('metris',               'Mercedes-Benz Metris',             'van',   60),
  ('express-savana',       'Chevy Express / GMC Savana',       'van',   70),
  ('city-express',         'Chevy City Express',               'van',   80),
  ('brightdrop',           'BrightDrop Zevo',                  'van',   90),
  ('f-150',                'Ford F-150',                       'truck', 110),
  ('super-duty',           'Ford Super Duty (F-250/350)',      'truck', 120),
  ('maverick',             'Ford Maverick',                    'truck', 130),
  ('ram-1500',             'Ram 1500',                         'truck', 140),
  ('ram-hd',               'Ram HD (2500/3500)',               'truck', 150),
  ('silverado-sierra-1500','Chevy Silverado / GMC Sierra 1500','truck', 160),
  ('silverado-sierra-hd',  'Chevy Silverado / GMC Sierra HD',  'truck', 170),
  ('frontier',             'Nissan Frontier',                  'truck', 180),
  ('tacoma',               'Toyota Tacoma',                    'truck', 190)
ON CONFLICT (key) DO NOTHING;
