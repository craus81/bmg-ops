-- Migration 500: FleetSuite's own books, part 72 — the report builder.
--
-- Owner decision 2026-10-31 (thread "Replacing NetSuite with FleetSuite",
-- the NetSuite Exit Checklist's "Report builder": your own reports by rows,
-- columns, filters and dates, and the P&L by division and by location). The
-- builder (src/lib/books/report-builder.ts) lays out each of its columns as
-- Reports lays out the profit and loss (src/lib/books/reports.ts), from this:
--   * gl_books_split_totals(company), the company's journal lines on its
--     income and expense accounts summed per account, month, division and
--     location. It sums the same lines per account and month as
--     gl_books_totals (migration 396), so its columns come to the profit
--     and loss on Reports.
-- A line's division is its own: the invoice rule files each sale line by
-- its item (owner rule 2026-10-06, src/lib/division-revenue.ts). A cost or
-- expense line with none takes its item's by the same rule
-- (gl_item_division), or, with no item, the division of its document's sale
-- lines when every one of them that has a division has the same; else it
-- has none (the builder's "Not split"). A sale line keeps what the invoice
-- rule gave it.
-- A line's location is its own (gl_lines.location, a key as
-- src/lib/invoice-location.ts names it); else the location NetSuite has on
-- the line of its document the line copies, else on the document itself
-- (its first line that has one); else it has none ("No location"). A
-- reversal's document is the entry it reverses.
-- Read-only functions, service role only, no table changes.

-- The division an item number files under by its number alone, as
-- revenueBucket (src/lib/division-revenue.ts) files an invoice line:
-- graphics for 3M Vinyl, Graphics Install Labor, Graphics Removal and any
-- number starting "06"; upfit for any other; none for no number, or freight
-- and shipping, which the owner leaves out of both. revenueBucket's rules
-- by item type (layout lines, shipping and discount items) are for sale
-- lines, which carry their own division.
CREATE OR REPLACE FUNCTION public.gl_item_division(p_item TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN x.n = '' OR x.n ~ '(FREIGHT|SHIPPING)' THEN NULL
    WHEN x.n IN ('3M VINYL', 'GRAPHICS INSTALL LABOR', 'GRAPHICS REMOVAL') OR left(x.n, 2) = '06' THEN 'graphics'
    ELSE 'upfit'
  END
  -- As normalizeItemNumber: the part after the last colon, trimmed, in capitals.
  FROM (SELECT upper(btrim(regexp_replace(coalesce(p_item, ''), '^.*:', ''), E' \t\r\n')) AS n) x
$$;

CREATE OR REPLACE FUNCTION public.gl_books_split_totals(p_company TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH lines AS (
    SELECT coalesce(a.netsuite_account_id, 'fs:' || a.id::text) AS account,
           a.account_type,
           date_trunc('month', l.entry_date)::date AS month,
           l.debit, l.credit, l.division, l.location, l.item_number, l.source_line_ref,
           coalesce(o.source_id, e.source_id) AS doc
    FROM public.gl_lines l
    JOIN public.gl_accounts a ON a.id = l.account_id
    JOIN public.gl_entries e ON e.id = l.entry_id
    LEFT JOIN public.gl_entries o ON o.id = e.reverses_entry_id
    WHERE l.company_id = (SELECT id FROM public.gl_companies WHERE code = p_company)
      AND a.statement = 'income_statement'
  ),
  -- A document's division: the one its sale lines that have a division share.
  sold AS (
    SELECT doc, min(division) AS division
    FROM lines
    WHERE doc IS NOT NULL AND division IS NOT NULL AND account_type IN ('income', 'other_income')
    GROUP BY doc
    HAVING count(DISTINCT division) = 1
  ),
  -- A NetSuite document's own location: its first line that has one.
  placed AS (
    SELECT DISTINCT ON (g.transaction_id) g.transaction_id AS doc, g.location_id
    FROM public.gl_netsuite_lines g
    WHERE g.location_id IS NOT NULL
      AND g.transaction_id IN (SELECT doc FROM lines WHERE location IS NULL)
    ORDER BY g.transaction_id, g.line_id::bigint
  ),
  split AS (
    SELECT x.account, x.month, x.debit, x.credit,
           CASE
             WHEN x.division IS NOT NULL THEN x.division
             WHEN x.account_type NOT IN ('cost_of_goods_sold', 'expense', 'other_expense') THEN NULL
             WHEN x.item_number IS NOT NULL THEN public.gl_item_division(x.item_number)
             ELSE s.division
           END AS division,
           x.location,
           CASE WHEN x.location IS NULL THEN coalesce(n.location_id, p.location_id) END AS netsuite_location
    FROM lines x
    LEFT JOIN sold s ON s.doc = x.doc
    LEFT JOIN public.gl_netsuite_lines n ON n.transaction_id = x.doc AND n.line_id = x.source_line_ref
    LEFT JOIN placed p ON p.doc = x.doc
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'account', y.account, 'month', to_char(y.month, 'YYYY-MM-DD'), 'division', y.division,
    'location', y.location, 'netsuite_location', y.netsuite_location,
    'debit', y.debit::text, 'credit', y.credit::text
  ) ORDER BY y.account, y.month, y.division NULLS LAST, y.location NULLS LAST, y.netsuite_location NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT account, month, division, location, netsuite_location, sum(debit) AS debit, sum(credit) AS credit
    FROM split
    GROUP BY 1, 2, 3, 4, 5
  ) y
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.gl_item_division(text)', 'public.gl_books_split_totals(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.gl_item_division(text) IS 'Migration 500: the division an item number files under by its number alone, as revenueBucket in src/lib/division-revenue.ts files an invoice line (owner rule 2026-10-06): graphics for 3M Vinyl, Graphics Install Labor, Graphics Removal and numbers starting 06, upfit for any other, null for no number or freight and shipping. Service role only.';
COMMENT ON FUNCTION public.gl_books_split_totals(text) IS 'Migration 500: one company''s journal lines on its income and expense accounts summed per account (its NetSuite id, or fs:<id>), month of entry date, division (the line''s own; on a cost or expense line without one, its item''s, else its document''s sale lines'' when they share one) and location (the line''s own key, else NetSuite''s location on the line it copies or on its document), for the report builder''s profit and loss by period, division and location. Service role only.';
