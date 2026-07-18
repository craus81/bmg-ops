-- Margin-visible quoting: show true cost (part cost + avg installer cost)
-- beside the sales price in both quote builders, with a warning below an
-- admin-set floor.

-- One shared floor for the estimate builder and the wrap-quote builder.
CREATE TABLE IF NOT EXISTS quote_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  margin_floor_pct NUMERIC(5,2) NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ,
  updated_by UUID REFERENCES profiles(id)
);
INSERT INTO quote_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE quote_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff can read quote settings' AND tablename = 'quote_settings') THEN
    CREATE POLICY "Staff can read quote settings" ON quote_settings
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admins can manage quote settings' AND tablename = 'quote_settings') THEN
    CREATE POLICY "Admins can manage quote settings" ON quote_settings
      FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
  END IF;
END $$;

-- What the film actually costs us per square foot (the existing
-- price_per_sqft columns are what we CHARGE) — set on the wrap-quote
-- Pricing tab, drives the wrap builder's margin readout.
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS cost_per_sqft NUMERIC(8,2);
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS laminate_cost_per_sqft NUMERIC(8,2);
