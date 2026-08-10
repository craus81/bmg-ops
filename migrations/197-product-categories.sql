-- Migration 197: product categories + part images (roadmap N4 phase A)
--
-- Craig 2026-08-10: build the Ranger-Design-style browse experience for
-- creating estimates — pictures, categories, vendors — and fold Masterack
-- and the other vendors' parts into it. The binding constraint is data
-- (roadmap N4): no product photos and no category tree exist, so this is
-- the "shelf": an admin-managed category vocabulary + a per-part category
-- and photo, stocked from inside the catalog browser itself. Facets that
-- already have data (vendor, ns_class, catalog, vehicle_type) work from
-- day one.
--
-- Both columns are FleetSuite-owned (migration-080 pattern): the parts
-- sync never writes them, so assignments and photos survive every resync.
-- This vocabulary is also the K11-classification / S1 / K17 data seed the
-- Aug 6 plan wanted — Ashley's "product category list" lands HERE, in-app,
-- instead of as a spreadsheet.

CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE netsuite_parts
  ADD COLUMN IF NOT EXISTS product_category_id UUID REFERENCES product_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS image_path TEXT,
  ADD COLUMN IF NOT EXISTS marketing_description TEXT;

CREATE INDEX IF NOT EXISTS idx_netsuite_parts_category ON netsuite_parts(product_category_id);

COMMENT ON COLUMN netsuite_parts.product_category_id IS
  'FleetSuite-owned browse category (product_categories) — never written by the parts sync.';
COMMENT ON COLUMN netsuite_parts.image_path IS
  'R2 path (photos bucket) of the product photo shown in the catalog browser. FleetSuite-owned.';
COMMENT ON COLUMN netsuite_parts.marketing_description IS
  'Customer-facing product blurb for the catalog browser (e.g. imported from the vendor''s site). FleetSuite-owned — the sync owns description and would overwrite it.';

-- Starter vocabulary — standard van-upfit categories, editable/extendable
-- in-app (Ashley's audit refines this list, not a migration).
INSERT INTO product_categories (name, sort_order) VALUES
  ('Shelving', 10),
  ('Partitions', 20),
  ('Ladder Racks', 30),
  ('Bins & Drawers', 40),
  ('Flooring', 50),
  ('Lighting & Electrical', 60),
  ('Safety & Security', 70),
  ('Telematics', 80),
  ('Graphics & Wraps', 90),
  ('Labor & Services', 100)
ON CONFLICT (name) DO NOTHING;

-- Everyone browsing the catalog reads categories; admins manage them via
-- the service-role API.
ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated read product categories' AND tablename = 'product_categories') THEN
    CREATE POLICY "Authenticated read product categories" ON product_categories
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
