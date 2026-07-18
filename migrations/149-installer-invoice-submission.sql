-- Installer invoice self-submission: CNI installers submit and track their
-- own vendor invoices from the portal.
--
-- Also fixes an RLS gap this feature would otherwise widen:
-- is_internal_staff() only excludes 'customer', so external installer
-- accounts could read EVERY vendor invoice (all companies' pricing) through
-- the browser client. Replace the blanket policy with an office-staff
-- policy plus a read-only own-company policy for installers.

-- The signed-in user's company link (profiles.company_id), usable inside
-- policies regardless of the profiles table's own RLS.
CREATE OR REPLACE FUNCTION public.get_my_company_id()
RETURNS UUID AS $$
  SELECT company_id FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '';

DROP POLICY IF EXISTS "Internal staff can manage vendor invoices" ON vendor_invoices;
DROP POLICY IF EXISTS "Internal staff can manage vendor invoice lines" ON vendor_invoice_lines;
DROP POLICY IF EXISTS "Office staff can manage vendor invoices" ON vendor_invoices;
DROP POLICY IF EXISTS "Office staff can manage vendor invoice lines" ON vendor_invoice_lines;
DROP POLICY IF EXISTS "Installers can view their company's vendor invoices" ON vendor_invoices;
DROP POLICY IF EXISTS "Installers can view their company's vendor invoice lines" ON vendor_invoice_lines;

CREATE POLICY "Office staff can manage vendor invoices" ON vendor_invoices
  FOR ALL TO authenticated
  USING (public.get_my_roles() && ARRAY['admin','finance','sales','graphics_production','production','shop_tech','field_tech']::text[])
  WITH CHECK (public.get_my_roles() && ARRAY['admin','finance','sales','graphics_production','production','shop_tech','field_tech']::text[]);

CREATE POLICY "Installers can view their company's vendor invoices" ON vendor_invoices
  FOR SELECT TO authenticated
  USING (
    'installer' = ANY(public.get_my_roles())
    AND company_id IS NOT NULL
    AND company_id = public.get_my_company_id()
  );

CREATE POLICY "Office staff can manage vendor invoice lines" ON vendor_invoice_lines
  FOR ALL TO authenticated
  USING (public.get_my_roles() && ARRAY['admin','finance','sales','graphics_production','production','shop_tech','field_tech']::text[])
  WITH CHECK (public.get_my_roles() && ARRAY['admin','finance','sales','graphics_production','production','shop_tech','field_tech']::text[]);

CREATE POLICY "Installers can view their company's vendor invoice lines" ON vendor_invoice_lines
  FOR SELECT TO authenticated
  USING (
    'installer' = ANY(public.get_my_roles())
    AND EXISTS (
      SELECT 1 FROM public.vendor_invoices vi
      WHERE vi.id = vendor_invoice_id
        AND vi.company_id IS NOT NULL
        AND vi.company_id = public.get_my_company_id()
    )
  );
