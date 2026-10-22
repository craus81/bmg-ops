-- Migration 426: FleetSuite's own books — sales by location and class.
--
-- Owner request 2026-10-22 (thread "Audit document request for 9/2025 to
-- 8/2026"): Liberty Mutual's premium audit asks for gross sales by
-- originating location (state) and product type, with returns, discounts and
-- transportation charges apart. Books holds every NetSuite general ledger
-- line with its location and class (migration 361), so the report
-- (src/lib/books/sales-report.ts) reads them from this:
--   * gl_sales_lines(company, from, to), the company's NetSuite lines on
--     income accounts for the posting months from through to, summed per
--     transaction type, account, location and class, with the names of the
--     account, location and class. Its total is the income on NetSuite's
--     profit and loss for those months.
-- A read-only function, service role only, no table changes.

CREATE OR REPLACE FUNCTION public.gl_sales_lines(p_company TEXT, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tran_type', x.tran_type,
    'account', x.account, 'account_number', x.account_number, 'account_name', x.account_name,
    'location_id', x.location_id, 'location', x.location,
    'class_id', x.class_id, 'class', x.class,
    'debit', x.debit::text, 'credit', x.credit::text, 'lines', x.lines
  ) ORDER BY x.account_number, x.account, x.tran_type, x.location, x.class), '[]'::jsonb)
  FROM (
    SELECT t.tran_type,
           l.netsuite_account_id AS account,
           a.number AS account_number,
           a.name AS account_name,
           l.location_id,
           loc.name AS location,
           l.class_id,
           cls.name AS class,
           sum(l.debit) AS debit,
           sum(l.credit) AS credit,
           count(*) AS lines
    FROM public.gl_netsuite_lines l
    JOIN public.gl_netsuite_transactions t ON t.netsuite_id = l.transaction_id
    JOIN public.gl_accounts a ON a.netsuite_account_id = l.netsuite_account_id
    LEFT JOIN public.gl_netsuite_lists loc ON loc.kind = 'location' AND loc.netsuite_id = l.location_id
    LEFT JOIN public.gl_netsuite_lists cls ON cls.kind = 'class' AND cls.netsuite_id = l.class_id
    WHERE l.company_id = (SELECT id FROM public.gl_companies WHERE code = p_company)
      AND l.posting_month BETWEEN date_trunc('month', p_from)::date AND date_trunc('month', p_to)::date
      AND a.account_type = 'income'
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
  ) x
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT := 'public.gl_sales_lines(text, date, date)';
  r TEXT;
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_sales_lines(text, date, date) IS 'Migration 426: one company''s NetSuite ledger lines on income accounts for a range of posting months, summed per transaction type, account, location and class, with their names, for Books → Sales by location. Service role only.';
