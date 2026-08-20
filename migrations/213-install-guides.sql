-- Install guides: dimensioned placement proofs for CNI installers.
--
-- Staff upload a 1:20 scale template/proof (raster pages; PDFs are
-- rasterized client-side via pdfjs), draw engineering-style dimension
-- lines on it (stored in image-pixel coordinates, converted to real
-- vehicle inches through a per-page px_per_in calibration), and export
-- a branded PDF guide — cover, best-practice sections, the dimensioned
-- proof pages, and a dimension schedule — to hand to CNI installers so
-- graphics land exactly where the proof says.
--
-- One row per guide. Pages and text sections live in JSONB rather than
-- child tables: they are only ever read and written as a unit by the
-- editor, never queried across guides.
--   pages:    [{ id, name, image_path, image_w, image_h, px_per_in,
--                dims: [{ id, kind: 'dim'|'note', p1:{x,y}, p2:{x,y},
--                         offset, label, note }] }]
--   sections: [{ id, title, body, include }]

CREATE TABLE IF NOT EXISTS install_guides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL DEFAULT '',
  customer_name TEXT,
  -- Year/make/model line shown on every proof page, so the installer can
  -- verify the guide matches the vehicle in front of them.
  vehicle_desc TEXT,
  -- Template scale the source artwork was drawn at ('1:20' → 20 template
  -- inches per real inch). Informational on export; calibration itself is
  -- the per-page px_per_in.
  scale TEXT NOT NULL DEFAULT '1:20',
  units TEXT NOT NULL DEFAULT 'in' CHECK (units IN ('in', 'ft-in')),
  -- Dimension labels round to the nearest 1/N inch.
  fraction_denominator INT NOT NULL DEFAULT 8,
  pages JSONB NOT NULL DEFAULT '[]',
  sections JSONB NOT NULL DEFAULT '[]',
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_install_guides_updated_at
  ON install_guides(updated_at DESC);

ALTER TABLE install_guides ENABLE ROW LEVEL SECURITY;

-- Same audience as the wrap-quote estimator: admin, sales, and graphics
-- production. get_my_roles() (migration 027) resolves the roles[] array
-- with the legacy single-role fallback.
DROP POLICY IF EXISTS "install_guides_staff" ON install_guides;
CREATE POLICY "install_guides_staff" ON install_guides FOR ALL TO authenticated USING (
  public.get_my_roles() && ARRAY['admin', 'sales', 'graphics_production', 'production']
);

COMMENT ON TABLE install_guides IS 'Dimensioned install guides built at /graphics/install-guides — 1:20 template pages annotated with dimension lines, exported as a PDF for CNI installers.';
