-- Migration 245: one company sales tax rate, editable by super admins only.
--
-- Before this, the rate was typed by hand on every estimate (the builder's
-- "Tax Rate" box), typed again on the wrap-quote Settings tab
-- (wrap_quote_settings.tax_rate), and hard-coded as 0.0795 in three server
-- routes. Anyone who could open a builder could quote at whatever rate they
-- felt like. Now quote_settings holds the single rate and only a super admin
-- may change it -- enforced here in the database, not just in the UI.
--
-- Stored as a PERCENT (7.95 = 7.95%), matching quote_settings.margin_floor_pct
-- and the wrap builder. The estimate builder's tax_rate is a FRACTION, so
-- src/lib/sales-tax.ts converts on read.

-- Seed from the wrap builder's existing rate the first time only: re-running
-- the migration must not clobber a rate a super admin has since set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'quote_settings'
      AND column_name = 'sales_tax_rate_pct'
  ) THEN
    ALTER TABLE quote_settings
      ADD COLUMN sales_tax_rate_pct NUMERIC(6,3) NOT NULL DEFAULT 7.95
      CHECK (sales_tax_rate_pct >= 0 AND sales_tax_rate_pct <= 100);

    INSERT INTO quote_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    UPDATE quote_settings q
       SET sales_tax_rate_pct = w.tax_rate
      FROM wrap_quote_settings w
     WHERE q.id = 1 AND w.id = 1
       AND w.tax_rate > 0 AND w.tax_rate <= 100;
  END IF;
END $$;

-- Role helper, mirroring public.is_admin() (migration 045). super_admin lives
-- in the roles ARRAY, never in the scalar `role` column, so go through
-- get_my_roles() rather than reading profiles.role.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT 'super_admin' = ANY(public.get_my_roles())
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '';

-- RLS is row-level, and the existing "Admins can manage quote settings" policy
-- has to keep letting plain admins set margin_floor_pct on the same row. A
-- trigger is what gives us the column-level rule: everything else on the row
-- stays admin-writable, the tax rate does not.
--
-- auth.uid() IS NULL means a service-role caller (our API routes, the migration
-- runner) -- those enforce super_admin themselves in /api/admin/sales-tax.
CREATE OR REPLACE FUNCTION public.quote_settings_guard_tax_rate()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sales_tax_rate_pct IS DISTINCT FROM OLD.sales_tax_rate_pct
     AND auth.uid() IS NOT NULL
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can change the sales tax rate';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

DROP TRIGGER IF EXISTS quote_settings_guard_tax_rate ON quote_settings;
CREATE TRIGGER quote_settings_guard_tax_rate
  BEFORE UPDATE ON quote_settings
  FOR EACH ROW EXECUTE FUNCTION public.quote_settings_guard_tax_rate();
