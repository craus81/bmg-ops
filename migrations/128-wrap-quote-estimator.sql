-- Manual wrap-quote estimator (WrapUP-style workflow): pick a 1:20 vehicle
-- outline template, draw measurement shapes over it (box / circle / roof /
-- hood line-pairs), price each area by substrate ($/sqft + bleed), add
-- design / preparation / installation labor and tax, then save + email the
-- quote. This is a separate flow from the AI proof-analysis quoting in
-- `quotes`/`quote_panels` (/admin/quotes): there the AI sizes a finished
-- proof; here a person measures the vehicle by hand before any design exists.

-- vehicle_templates already models the 1:20 template library (make / model /
-- year / variant, template_image_path). px_per_in is the calibration for the
-- estimator: how many image pixels equal one real-world inch, set once per
-- template by drawing a line of known length over the outline. is_active
-- retires templates without deleting rows that quotes reference.
ALTER TABLE vehicle_templates ADD COLUMN IF NOT EXISTS template_code TEXT;
ALTER TABLE vehicle_templates ADD COLUMN IF NOT EXISTS px_per_in NUMERIC;
ALTER TABLE vehicle_templates ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Printable materials. price_per_sqft drives quote generation; bleed_in is
-- extra printed margin (inches) added to each side of a measured dimension
-- before pricing, since you print larger than the trim size.
CREATE TABLE IF NOT EXISTS wrap_substrates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  price_per_sqft NUMERIC NOT NULL DEFAULT 0,
  bleed_in NUMERIC NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Org-level estimator settings: company block shown on quotes, tax rate, and
-- the three labor sections (each {flat, hourly, hours, extra}). Singleton row
-- (id = 1) so the UI can upsert without key management.
CREATE TABLE IF NOT EXISTS wrap_quote_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company JSONB NOT NULL DEFAULT '{}'::jsonb,
  tax_rate NUMERIC NOT NULL DEFAULT 0,
  design JSONB NOT NULL DEFAULT '{"flat":0,"hourly":0,"hours":0,"extra":0}'::jsonb,
  preparation JSONB NOT NULL DEFAULT '{"flat":0,"hourly":0,"hours":0,"extra":0}'::jsonb,
  installation JSONB NOT NULL DEFAULT '{"flat":0,"hourly":0,"hours":0,"extra":0}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO wrap_quote_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- One row per wrap quote. measurements and labor are snapshots taken at
-- quote time (substrate name/price/bleed embedded per measurement), so
-- history stays correct when substrate prices or labor rates change later.
CREATE TABLE IF NOT EXISTS wrap_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number TEXT NOT NULL UNIQUE,
  template_id UUID REFERENCES vehicle_templates(id),
  vehicle_description TEXT,
  customer_id UUID REFERENCES customers(id),
  customer JSONB NOT NULL DEFAULT '{}'::jsonb,
  project_type TEXT,
  project_notes TEXT,
  measurements JSONB NOT NULL DEFAULT '[]'::jsonb,
  labor JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_area_sqft NUMERIC DEFAULT 0,
  materials_total NUMERIC DEFAULT 0,
  labor_total NUMERIC DEFAULT 0,
  subtotal NUMERIC DEFAULT 0,
  tax_rate NUMERIC DEFAULT 0,
  tax_amount NUMERIC DEFAULT 0,
  total NUMERIC DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  sent_at TIMESTAMPTZ,
  sent_to TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wrap_quotes_created ON wrap_quotes(created_at DESC);

-- RLS: staff-only estimating data, same audience as /admin/quotes and the
-- Wrap Estimator (admin + sales + graphics production; 'production' is the
-- legacy alias for graphics_production).
ALTER TABLE wrap_substrates ENABLE ROW LEVEL SECURITY;
ALTER TABLE wrap_quote_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wrap_quotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wrap_substrates_staff" ON wrap_substrates;
CREATE POLICY "wrap_substrates_staff" ON wrap_substrates FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid()
    AND profiles.role IN ('admin', 'sales', 'graphics_production', 'production'))
);

DROP POLICY IF EXISTS "wrap_quote_settings_staff" ON wrap_quote_settings;
CREATE POLICY "wrap_quote_settings_staff" ON wrap_quote_settings FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid()
    AND profiles.role IN ('admin', 'sales', 'graphics_production', 'production'))
);

DROP POLICY IF EXISTS "wrap_quotes_staff" ON wrap_quotes;
CREATE POLICY "wrap_quotes_staff" ON wrap_quotes FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid()
    AND profiles.role IN ('admin', 'sales', 'graphics_production', 'production'))
);
