-- Migration 504: FleetSuite's own books, part 80 — Home → Financials on
-- FleetSuite's books, switched off.
--
-- The NetSuite Exit Checklist's "Money screens on FleetSuite's books"
-- (thread "Replacing NetSuite with FleetSuite", owner's go-ahead
-- 2026-10-31): Home → Financials reads NetSuite live, and NetSuite's income
-- statement read has no company in it, so its profit and loss most likely
-- has 1084's rent and mortgage in BMG's. With the switch on, the tab reads
-- BMG's own books in FleetSuite instead (src/lib/books/money-screens.ts,
-- docs/books.md "Money screens"). This adds:
--   * books_switches gets 'money_screens', off;
--   * gl_books_collections(company, from, to), what customers paid in one
--     company's books between two days, as the tab's Collections reads
--     NetSuite's customer payments and deposits: the money side of each
--     customer payment (payment@1's deposit line) and customer deposit (its
--     money line), debit positive, by entry date, a reversal counting
--     against the document it reverses in the day it's dated. A deposit
--     applied to an invoice is no money coming in, so it isn't counted.
--
-- Read-only function, service role only; the switch is the only table
-- change.

-- ── The switch ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%piece%'
  LOOP
    EXECUTE format('ALTER TABLE public.books_switches DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE books_switches ADD CONSTRAINT books_switches_piece_check
  CHECK (piece IN ('credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes',
                   'bill_fixes', 'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records',
                   'customer_payments', 'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals',
                   'own_numbers', 'invoice_pdfs', 'stock_counts', 'money_screens'));

INSERT INTO books_switches (piece) VALUES ('money_screens') ON CONFLICT (piece) DO NOTHING;

-- ── Collections ────────────────────────────────────────────────────────────

-- What customers paid in one company's books from p_from through p_to, both
-- days counted: { total, count }, total a decimal string, the money each
-- customer payment and customer deposit brought in, and count how many of
-- them brought money in. A payment posted, reversed and posted again counts
-- once, at what it brought in last; one reversed in a later month takes its
-- money off that month's total.
CREATE OR REPLACE FUNCTION public.gl_books_collections(p_company TEXT, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH money AS (
    SELECT coalesce(o.source_type, e.source_type) AS source_type,
           coalesce(o.source_id, e.source_id) AS source_id,
           l.debit - l.credit AS amount
    FROM public.gl_lines l
    JOIN public.gl_entries e ON e.id = l.entry_id
    LEFT JOIN public.gl_entries o ON o.id = e.reverses_entry_id
    WHERE l.company_id = (SELECT id FROM public.gl_companies WHERE code = p_company)
      AND l.entry_date BETWEEN p_from AND p_to
      AND ((coalesce(o.source_type, e.source_type) = 'payment' AND l.source_line_ref = 'deposit')
        OR (coalesce(o.source_type, e.source_type) = 'customer_deposit' AND l.source_line_ref = 'money'))
  ), documents AS (
    SELECT source_type, source_id, sum(amount) AS amount FROM money GROUP BY source_type, source_id
  )
  SELECT jsonb_build_object(
    'total', coalesce(sum(amount), 0)::numeric(16,2)::text,
    'count', count(*) FILTER (WHERE amount > 0)
  )
  FROM documents
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT := 'public.gl_books_collections(text, date, date)';
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

COMMENT ON FUNCTION public.gl_books_collections(text, date, date) IS 'Migration 504: what customers paid in one company''s books between two days (both counted), the money side of each customer payment and customer deposit by entry date, a reversal counting against what it reverses, as { total, count }, for Home Financials'' Collections on FleetSuite''s books. Service role only.';
