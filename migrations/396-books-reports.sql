-- Migration 396: FleetSuite's own books, part 16 — reports.
--
-- Owner decision 2026-10-17 (thread "Replacing NetSuite with FleetSuite",
-- "Reports"): a profit and loss, a balance sheet and a trial balance from
-- FleetSuite's own books, each month next to NetSuite's. The page
-- (src/lib/books/reports.ts) takes NetSuite's side from NetSuite's own
-- totals, as the trial balance check does (gl_netsuite_totals, migration
-- 361), and FleetSuite's from this:
--   * gl_books_totals(company), the company's journal summed per account
--     and month: every line's debits and credits in the month of its
--     entry's date, a reversal in the month it's dated like any other
--     entry. An account is named by its NetSuite id, or 'fs:<id>' for one
--     NetSuite doesn't have, as gl_books_differences (migration 377) names
--     them.
-- A read-only function, service role only, no table changes.

CREATE OR REPLACE FUNCTION public.gl_books_totals(p_company TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'account', x.account, 'month', to_char(x.month, 'YYYY-MM-DD'), 'debit', x.debit::text, 'credit', x.credit::text
  ) ORDER BY x.account, x.month), '[]'::jsonb)
  FROM (
    SELECT coalesce(a.netsuite_account_id, 'fs:' || a.id::text) AS account,
           date_trunc('month', l.entry_date)::date AS month,
           sum(l.debit) AS debit,
           sum(l.credit) AS credit
    FROM public.gl_lines l
    JOIN public.gl_accounts a ON a.id = l.account_id
    WHERE l.company_id = (SELECT id FROM public.gl_companies WHERE code = p_company)
    GROUP BY 1, 2
  ) x
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT := 'public.gl_books_totals(text)';
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

COMMENT ON FUNCTION public.gl_books_totals(text) IS 'Migration 396: one company''s journal summed per account (its NetSuite id, or fs:<id>) and month of entry date, debits and credits apart, for the reports page''s profit and loss, balance sheet and trial balance. Service role only.';
