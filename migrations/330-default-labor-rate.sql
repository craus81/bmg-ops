-- Migration 330: one company default labor rate (Settings -> Default Labor
-- Rate), editable by super admins only.
--
-- Before this, the $/hour a new estimate SELLS labor at was hard-coded, and
-- not even consistently: $115 in the estimate builder, $120 in graphics
-- create-estimate and the AI assistant, $85 in the upfit designer and the
-- estimates API fallback. Now quote_settings holds the one number and every
-- path reads it. The per-estimate Labor Rate box stays editable, and saved
-- estimates keep the rate they were quoted at.
--
-- Not to be confused with shop_labor_cost_rate (migration 269), which is what
-- an hour COSTS the company, for the margin report.

ALTER TABLE quote_settings
  ADD COLUMN IF NOT EXISTS default_labor_rate NUMERIC(10,2) NOT NULL DEFAULT 120
  CHECK (default_labor_rate >= 0 AND default_labor_rate <= 1000);

INSERT INTO quote_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Any insert that names no rate gets the new standard too, not the old $85.
ALTER TABLE estimates ALTER COLUMN labor_rate SET DEFAULT 120;

-- The row stays admin-writable (margin_floor_pct); this column, like the tax
-- rate (migration 245), is super-admin only. auth.uid() IS NULL is a
-- service-role caller (our API routes, which check super_admin themselves).
CREATE OR REPLACE FUNCTION public.quote_settings_guard_labor_rate()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.default_labor_rate IS DISTINCT FROM OLD.default_labor_rate
     AND auth.uid() IS NOT NULL
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can change the default labor rate';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

DROP TRIGGER IF EXISTS quote_settings_guard_labor_rate ON quote_settings;
CREATE TRIGGER quote_settings_guard_labor_rate
  BEFORE UPDATE ON quote_settings
  FOR EACH ROW EXECUTE FUNCTION public.quote_settings_guard_labor_rate();

COMMENT ON COLUMN quote_settings.default_labor_rate IS
  'Migration 330: $/hour new estimates sell labor at (Settings -> Default Labor Rate; super-admin write). Editable per estimate.';
