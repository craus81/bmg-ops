-- Migration 214: interior cargo geometry per (platform, wheelbase, roof)
--
-- Craig 2026-08-20: the 3D upfit designer draws the van the rep is designing
-- into — cargo box, wheel wells, door openings — so layouts respect the real
-- space. vehicle_platforms.config says WHICH wheelbase/roof combos exist;
-- this table says what each combo measures inside. One row per combo, keyed
-- by the same option labels the config vocabulary uses ('148 EL', 'high').
-- roof_label is '' (not NULL) for platforms without roof options
-- (Express/Savana) so the UNIQUE key stays simple.
--
-- The designer's vehicle picker offers ONLY combos that have a row here —
-- config combos without one show as "geometry not yet available". Adding a
-- vehicle to the configurator is adding a row, not code.
--
-- geometry is a versioned JSONB shape (all inches; the designer's world
-- units). Origin: cargo-floor center at the bulkhead face; +Z rearward,
-- +Y up, +X toward the passenger side.
--   { "version": 1, "units": "in",
--     "cargo":      { "length", "width", "height", "width_between_wheelwells" },
--     "wheelwells": [ { "side": "left"|"right", "from_bulkhead", "length", "width", "height" } ],
--     "doors":      { "rear": { "width", "height" },
--                     "side": { "side": "left"|"right", "from_bulkhead", "width", "height" } } }
--
-- Seed values are compiled from the manufacturers' published body-builder /
-- upfitter guides but are APPROXIMATE (wheel-well positions especially) —
-- source='seed' marks them for review in the /admin/vehicle-interiors editor
-- before anyone quotes a wall-tight fit off them.

CREATE TABLE IF NOT EXISTS vehicle_interiors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id UUID NOT NULL REFERENCES vehicle_platforms(id) ON DELETE CASCADE,
  wheelbase_label TEXT NOT NULL,
  roof_label TEXT NOT NULL DEFAULT '',
  geometry JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'manual')),
  notes TEXT,
  updated_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_id, wheelbase_label, roof_label)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_interiors_platform ON vehicle_interiors(platform_id);

COMMENT ON TABLE vehicle_interiors IS 'Interior cargo geometry per platform + wheelbase + roof combo for the 3D upfit designer. Labels match vehicle_platforms.config vocabulary; roof_label='''' where the platform has no roof options.';
COMMENT ON COLUMN vehicle_interiors.geometry IS 'Versioned JSONB (inches): cargo box, wheel wells, door openings. Origin = cargo-floor center at bulkhead, +Z rearward, +Y up, +X passenger side.';
COMMENT ON COLUMN vehicle_interiors.source IS 'seed = compiled from published body-builder guides (approximate); manual = verified/edited by staff.';

ALTER TABLE vehicle_interiors ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can read vehicle interiors' AND tablename = 'vehicle_interiors') THEN
    CREATE POLICY "Authenticated users can read vehicle interiors" ON vehicle_interiors FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage vehicle interiors' AND tablename = 'vehicle_interiors') THEN
    CREATE POLICY "Internal staff can manage vehicle interiors" ON vehicle_interiors FOR ALL TO authenticated
      USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
  END IF;
END $$;

-- Seed: the four launch platforms (Craig 2026-08-20), most-sold combos only.
INSERT INTO vehicle_interiors (platform_id, wheelbase_label, roof_label, geometry, source, notes)
SELECT p.id, v.wheelbase, v.roof, v.geometry::jsonb, 'seed', v.notes
FROM (VALUES
  -- ── Ford Transit: width 70.2, between wells 54.8; medium roof 72.0, high roof 81.5.
  ('transit', '130', 'medium',
   '{"version":1,"units":"in","cargo":{"length":126.9,"width":70.2,"height":72.0,"width_between_wheelwells":54.8},"wheelwells":[{"side":"left","from_bulkhead":69,"length":38,"width":7.7,"height":10.6},{"side":"right","from_bulkhead":69,"length":38,"width":7.7,"height":10.6}],"doors":{"rear":{"width":61.0,"height":64.4},"side":{"side":"right","from_bulkhead":0,"width":51.7,"height":62.9}}}',
   'Ford Transit 130" WB medium roof — Ford BEMM figures, wheel-well position approximate.'),
  ('transit', '148', 'medium',
   '{"version":1,"units":"in","cargo":{"length":143.7,"width":70.2,"height":72.0,"width_between_wheelwells":54.8},"wheelwells":[{"side":"left","from_bulkhead":87,"length":38,"width":7.7,"height":10.6},{"side":"right","from_bulkhead":87,"length":38,"width":7.7,"height":10.6}],"doors":{"rear":{"width":61.0,"height":64.4},"side":{"side":"right","from_bulkhead":0,"width":51.7,"height":62.9}}}',
   'Ford Transit 148" WB medium roof — Ford BEMM figures, wheel-well position approximate.'),
  ('transit', '148', 'high',
   '{"version":1,"units":"in","cargo":{"length":143.7,"width":70.2,"height":81.5,"width_between_wheelwells":54.8},"wheelwells":[{"side":"left","from_bulkhead":87,"length":38,"width":7.7,"height":10.6},{"side":"right","from_bulkhead":87,"length":38,"width":7.7,"height":10.6}],"doors":{"rear":{"width":61.0,"height":74.3},"side":{"side":"right","from_bulkhead":0,"width":51.7,"height":72.4}}}',
   'Ford Transit 148" WB high roof — Ford BEMM figures, wheel-well position approximate.'),
  ('transit', '148 EL', 'high',
   '{"version":1,"units":"in","cargo":{"length":172.2,"width":70.2,"height":81.5,"width_between_wheelwells":54.8},"wheelwells":[{"side":"left","from_bulkhead":87,"length":38,"width":7.7,"height":10.6},{"side":"right","from_bulkhead":87,"length":38,"width":7.7,"height":10.6}],"doors":{"rear":{"width":61.0,"height":74.3},"side":{"side":"right","from_bulkhead":0,"width":51.7,"height":72.4}}}',
   'Ford Transit 148" EL (extended) high roof — Ford BEMM figures, wheel-well position approximate.'),
  -- ── Ram ProMaster: width 75.6, between wells 55.8; high roof 76.0.
  ('promaster', '118', 'high',
   '{"version":1,"units":"in","cargo":{"length":105.6,"width":75.6,"height":76.0,"width_between_wheelwells":55.8},"wheelwells":[{"side":"left","from_bulkhead":71,"length":34,"width":9.9,"height":9.5},{"side":"right","from_bulkhead":71,"length":34,"width":9.9,"height":9.5}],"doors":{"rear":{"width":62.0,"height":71.6},"side":{"side":"right","from_bulkhead":0,"width":49.0,"height":68.9}}}',
   'Ram ProMaster 118" WB high roof — Ram body-builder figures, wheel-well position approximate.'),
  ('promaster', '136', 'high',
   '{"version":1,"units":"in","cargo":{"length":123.6,"width":75.6,"height":76.0,"width_between_wheelwells":55.8},"wheelwells":[{"side":"left","from_bulkhead":89,"length":34,"width":9.9,"height":9.5},{"side":"right","from_bulkhead":89,"length":34,"width":9.9,"height":9.5}],"doors":{"rear":{"width":62.0,"height":71.6},"side":{"side":"right","from_bulkhead":0,"width":49.0,"height":68.9}}}',
   'Ram ProMaster 136" WB high roof — Ram body-builder figures, wheel-well position approximate.'),
  ('promaster', '159', 'high',
   '{"version":1,"units":"in","cargo":{"length":146.9,"width":75.6,"height":76.0,"width_between_wheelwells":55.8},"wheelwells":[{"side":"left","from_bulkhead":112,"length":34,"width":9.9,"height":9.5},{"side":"right","from_bulkhead":112,"length":34,"width":9.9,"height":9.5}],"doors":{"rear":{"width":62.0,"height":71.6},"side":{"side":"right","from_bulkhead":0,"width":49.0,"height":68.9}}}',
   'Ram ProMaster 159" WB high roof — Ram body-builder figures, wheel-well position approximate.'),
  ('promaster', '159 EXT', 'high',
   '{"version":1,"units":"in","cargo":{"length":165.3,"width":75.6,"height":76.0,"width_between_wheelwells":55.8},"wheelwells":[{"side":"left","from_bulkhead":112,"length":34,"width":9.9,"height":9.5},{"side":"right","from_bulkhead":112,"length":34,"width":9.9,"height":9.5}],"doors":{"rear":{"width":62.0,"height":71.6},"side":{"side":"right","from_bulkhead":0,"width":49.0,"height":68.9}}}',
   'Ram ProMaster 159" EXT high roof — Ram body-builder figures, wheel-well position approximate.'),
  -- ── Mercedes Sprinter: width 70.4, between wells 53.1; standard roof 67.7, high roof 79.1.
  ('sprinter', '144', 'standard',
   '{"version":1,"units":"in","cargo":{"length":132.9,"width":70.4,"height":67.7,"width_between_wheelwells":53.1},"wheelwells":[{"side":"left","from_bulkhead":78,"length":40,"width":8.7,"height":9.0},{"side":"right","from_bulkhead":78,"length":40,"width":8.7,"height":9.0}],"doors":{"rear":{"width":61.4,"height":60.8},"side":{"side":"right","from_bulkhead":0,"width":51.6,"height":60.2}}}',
   'Mercedes Sprinter 144" WB standard roof — MB body-builder figures, wheel-well position approximate.'),
  ('sprinter', '144', 'high',
   '{"version":1,"units":"in","cargo":{"length":132.9,"width":70.4,"height":79.1,"width_between_wheelwells":53.1},"wheelwells":[{"side":"left","from_bulkhead":78,"length":40,"width":8.7,"height":9.0},{"side":"right","from_bulkhead":78,"length":40,"width":8.7,"height":9.0}],"doors":{"rear":{"width":61.4,"height":71.9},"side":{"side":"right","from_bulkhead":0,"width":51.6,"height":70.9}}}',
   'Mercedes Sprinter 144" WB high roof — MB body-builder figures, wheel-well position approximate.'),
  ('sprinter', '170', 'high',
   '{"version":1,"units":"in","cargo":{"length":173.6,"width":70.4,"height":79.1,"width_between_wheelwells":53.1},"wheelwells":[{"side":"left","from_bulkhead":104,"length":40,"width":8.7,"height":9.0},{"side":"right","from_bulkhead":104,"length":40,"width":8.7,"height":9.0}],"doors":{"rear":{"width":61.4,"height":71.9},"side":{"side":"right","from_bulkhead":0,"width":51.6,"height":70.9}}}',
   'Mercedes Sprinter 170" WB high roof — MB body-builder figures, wheel-well position approximate.'),
  ('sprinter', '170 EXT', 'high',
   '{"version":1,"units":"in","cargo":{"length":189.4,"width":70.4,"height":79.1,"width_between_wheelwells":53.1},"wheelwells":[{"side":"left","from_bulkhead":104,"length":40,"width":8.7,"height":9.0},{"side":"right","from_bulkhead":104,"length":40,"width":8.7,"height":9.0}],"doors":{"rear":{"width":61.4,"height":71.9},"side":{"side":"right","from_bulkhead":0,"width":51.6,"height":70.9}}}',
   'Mercedes Sprinter 170" EXT high roof — MB body-builder figures, wheel-well position approximate.'),
  -- ── Chevy Express / GMC Savana: single roof height (roof_label ''), width 69.4, between wells 52.1.
  ('express-savana', '135', '',
   '{"version":1,"units":"in","cargo":{"length":126.0,"width":69.4,"height":53.4,"width_between_wheelwells":52.1},"wheelwells":[{"side":"left","from_bulkhead":70,"length":30,"width":8.7,"height":10.5},{"side":"right","from_bulkhead":70,"length":30,"width":8.7,"height":10.5}],"doors":{"rear":{"width":57.0,"height":49.0},"side":{"side":"right","from_bulkhead":0,"width":45.0,"height":48.0}}}',
   'Chevy Express / GMC Savana 135" WB — GM upfitter figures, wheel-well position approximate.'),
  ('express-savana', '155', '',
   '{"version":1,"units":"in","cargo":{"length":146.0,"width":69.4,"height":53.4,"width_between_wheelwells":52.1},"wheelwells":[{"side":"left","from_bulkhead":90,"length":30,"width":8.7,"height":10.5},{"side":"right","from_bulkhead":90,"length":30,"width":8.7,"height":10.5}],"doors":{"rear":{"width":57.0,"height":49.0},"side":{"side":"right","from_bulkhead":0,"width":45.0,"height":48.0}}}',
   'Chevy Express / GMC Savana 155" WB — GM upfitter figures, wheel-well position approximate.')
) AS v(key, wheelbase, roof, geometry, notes)
JOIN vehicle_platforms p ON p.key = v.key
ON CONFLICT (platform_id, wheelbase_label, roof_label) DO NOTHING;
