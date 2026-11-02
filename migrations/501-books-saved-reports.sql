-- Migration 501: FleetSuite's own books, part 73 — the report builder's
-- rows by customer and vendor, and reports saved by name.
--
-- Owner decision 2026-10-31 (thread "Replacing NetSuite with FleetSuite",
-- the NetSuite Exit Checklist's "Report builder": your own reports by rows,
-- columns, filters and dates). Part 72 (migration 500) laid FleetSuite's
-- profit and loss out by account with a column for each month, quarter,
-- year, division or location. This adds:
--   * gl_books_split_lines(company), the journal lines migration 500's
--     gl_books_split_totals sums, each with its division and location by
--     that migration's rules and the NetSuite document and line it copies.
--     gl_books_split_totals now sums these, so both reads below share the
--     rules; what it returns doesn't change.
--   * gl_books_party_totals(company, kind, from, to), the same lines in
--     the months from `from` through `to` summed per account, month,
--     division, location and customer (kind 'customer') or vendor (kind
--     'vendor'), with the names, for the builder's rows by customer or by
--     vendor (src/lib/books/report-builder.ts).
--   * books_saved_reports, reports saved by name: a company, its rows,
--     columns, filters and months, the months either picked or moving with
--     the calendar (the year to date, last month, last quarter, last year
--     or the last 12 months). Anyone who opens the books can save one; the
--     one who saved it or a super admin changes or deletes it
--     (books_saved_report_save and books_saved_report_remove).
--
-- A line's customer is the one NetSuite names on the line of its document
-- it copies, when NetSuite's customer list has that name; else the one
-- customer the document's lines name, when they name only one; else it has
-- none (the builder's "No customer"). A vendor likewise, from NetSuite's
-- vendor list: a bill's expense line that names a customer for the job
-- keeps the bill's vendor. NetSuite's ids are unique across its customers,
-- vendors, employees and other names, and its names come from the copy of
-- its lists (migration 363, customers since 407); an employee or other
-- name is neither. Until the copy of NetSuite's ledger has read a
-- document, its lines have no customer or vendor. A reversal's document
-- is the entry it reverses.
--
-- Read functions and saved reports are for the service role only.

-- ── The journal lines the builder splits ──────────────────────────────────

-- Each of one company's journal lines on its income and expense accounts:
-- its account (NetSuite's id, or fs:<id>), month, division and location by
-- migration 500's rules, and the NetSuite document (`doc`) and line
-- (`line_ref`) it copies.
CREATE OR REPLACE FUNCTION public.gl_books_split_lines(p_company TEXT)
RETURNS TABLE (
  account TEXT,
  month DATE,
  division TEXT,
  location TEXT,
  netsuite_location TEXT,
  doc TEXT,
  line_ref TEXT,
  debit NUMERIC,
  credit NUMERIC
)
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
  )
  SELECT x.account,
         x.month,
         CASE
           WHEN x.division IS NOT NULL THEN x.division
           WHEN x.account_type NOT IN ('cost_of_goods_sold', 'expense', 'other_expense') THEN NULL
           WHEN x.item_number IS NOT NULL THEN public.gl_item_division(x.item_number)
           ELSE s.division
         END,
         x.location,
         CASE WHEN x.location IS NULL THEN coalesce(n.location_id, p.location_id) END,
         x.doc,
         x.source_line_ref,
         x.debit,
         x.credit
  FROM lines x
  LEFT JOIN sold s ON s.doc = x.doc
  LEFT JOIN public.gl_netsuite_lines n ON n.transaction_id = x.doc AND n.line_id = x.source_line_ref
  LEFT JOIN placed p ON p.doc = x.doc
$$;

CREATE OR REPLACE FUNCTION public.gl_books_split_totals(p_company TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'account', y.account, 'month', to_char(y.month, 'YYYY-MM-DD'), 'division', y.division,
    'location', y.location, 'netsuite_location', y.netsuite_location,
    'debit', y.debit::text, 'credit', y.credit::text
  ) ORDER BY y.account, y.month, y.division NULLS LAST, y.location NULLS LAST, y.netsuite_location NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT s.account, s.month, s.division, s.location, s.netsuite_location, sum(s.debit) AS debit, sum(s.credit) AS credit
    FROM public.gl_books_split_lines(p_company) s
    GROUP BY 1, 2, 3, 4, 5
  ) y
$$;

-- The lines of the months from p_from through p_to ('YYYY-MM-01') summed
-- per account, month, division, location and customer or vendor (p_kind
-- 'customer' or 'vendor': NetSuite's id, null for none). Returns
-- { rows: [{ account, month, division, location, netsuite_location, party,
-- debit, credit }], names: { <NetSuite id>: <name> } }.
CREATE OR REPLACE FUNCTION public.gl_books_party_totals(p_company TEXT, p_kind TEXT, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH x AS (
    SELECT * FROM public.gl_books_split_lines(p_company) s WHERE s.month BETWEEN p_from AND p_to
  ),
  -- The names of that kind NetSuite has on the documents' lines.
  named AS (
    SELECT g.transaction_id AS doc, g.line_id, g.entity_id
    FROM public.gl_netsuite_lines g
    JOIN public.gl_netsuite_lists k ON k.kind = p_kind AND k.netsuite_id = g.entity_id
    WHERE g.transaction_id IN (SELECT doc FROM x)
  ),
  -- A document's own: the one name of that kind its lines have, when they have only one.
  documents AS (
    SELECT doc, min(entity_id) AS party
    FROM named
    GROUP BY doc
    HAVING count(DISTINCT entity_id) = 1
  ),
  totals AS (
    SELECT x.account, x.month, x.division, x.location, x.netsuite_location, coalesce(n.entity_id, d.party) AS party,
           sum(x.debit) AS debit, sum(x.credit) AS credit
    FROM x
    LEFT JOIN named n ON n.doc = x.doc AND n.line_id = x.line_ref
    LEFT JOIN documents d ON d.doc = x.doc
    GROUP BY 1, 2, 3, 4, 5, 6
  )
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'account', t.account, 'month', to_char(t.month, 'YYYY-MM-DD'), 'division', t.division,
        'location', t.location, 'netsuite_location', t.netsuite_location, 'party', t.party,
        'debit', t.debit::text, 'credit', t.credit::text
      ) ORDER BY t.account, t.month, t.division NULLS LAST, t.location NULLS LAST, t.netsuite_location NULLS LAST, t.party NULLS LAST)
      FROM totals t
    ), '[]'::jsonb),
    'names', coalesce((
      SELECT jsonb_object_agg(k.netsuite_id, k.name)
      FROM public.gl_netsuite_lists k
      WHERE k.kind = p_kind AND k.netsuite_id IN (SELECT party FROM totals)
    ), '{}'::jsonb)
  )
$$;

-- ── Saved reports ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS books_saved_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company TEXT NOT NULL REFERENCES gl_companies(code) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 60),
  -- What each row is: an account, a customer or a vendor.
  rows TEXT NOT NULL CHECK (rows IN ('account', 'customer', 'vendor')),
  -- What each column is, as the builder's `by`.
  columns TEXT NOT NULL CHECK (columns IN ('total', 'month', 'quarter', 'year', 'division', 'location')),
  -- The filters: a division's key, a location's (NetSuite's id, own:<key>), or 'none'; null for every one.
  division TEXT CHECK (division IN ('upfit', 'graphics', 'shared', 'none')),
  location TEXT CHECK (location ~ '^(none|[0-9]{1,12}|own:[a-z0-9_]{2,40})$'),
  -- The months: those picked (from_month through to_month), or ones that move with the calendar.
  months TEXT NOT NULL CHECK (months IN ('picked', 'year_to_date', 'last_month', 'last_quarter', 'last_year', 'last_12_months')),
  from_month DATE CHECK (from_month >= DATE '2025-01-01' AND EXTRACT(DAY FROM from_month) = 1),
  to_month DATE CHECK (EXTRACT(DAY FROM to_month) = 1),
  saved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  saved_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT books_saved_reports_months CHECK (
    CASE WHEN months = 'picked' THEN from_month IS NOT NULL AND to_month IS NOT NULL AND from_month <= to_month
         ELSE from_month IS NULL AND to_month IS NULL END
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS books_saved_reports_name ON books_saved_reports (company, lower(name));

-- Saves a report by name. p:
--   { id: the saved report to change, or null for a new one; seen: its updated_at as the page saw it;
--     company, name, rows, columns, division, location, months, from, to ('YYYY-MM-01', for months 'picked');
--     by: who saves it; by_name; owner: true for a super admin }
-- A new one is the saver's. One is changed only by its saver or a super
-- admin, and keeps its saver. Answers { state: 'saved', id, updated_at };
-- 'name_taken' when the company has another of that name (in any case);
-- 'gone' when it was deleted, 'changed' when it was saved since the page
-- saw it, 'not_yours' when someone else saved it.
CREATE OR REPLACE FUNCTION public.books_saved_report_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := nullif(p->>'id', '')::uuid;
  v_company TEXT := p->>'company';
  v_name TEXT := btrim(coalesce(p->>'name', ''));
  v_picked BOOLEAN := p->>'months' = 'picked';
  v_by UUID := nullif(p->>'by', '')::uuid;
  v_row public.books_saved_reports;
BEGIN
  -- One save at a time for a company, so two of one name can't both pass the check below.
  PERFORM pg_advisory_xact_lock(hashtext('books_saved_reports:' || coalesce(v_company, '')));
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.books_saved_reports WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('state', 'gone');
    END IF;
    IF v_row.updated_at IS DISTINCT FROM (p->>'seen')::timestamptz THEN
      RETURN jsonb_build_object('state', 'changed');
    END IF;
    -- A report whose saver's login was deleted is changed only by a super admin.
    IF NOT coalesce(v_row.saved_by = v_by, false) AND (p->>'owner')::boolean IS NOT TRUE THEN
      RETURN jsonb_build_object('state', 'not_yours');
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.books_saved_reports
    WHERE company = v_company AND lower(name) = lower(v_name) AND id IS DISTINCT FROM v_id
  ) THEN
    RETURN jsonb_build_object('state', 'name_taken');
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.books_saved_reports (company, name, rows, columns, division, location, months, from_month, to_month,
                                            saved_by, saved_by_name)
    VALUES (v_company, v_name, p->>'rows', p->>'columns', nullif(p->>'division', ''), nullif(p->>'location', ''), p->>'months',
            CASE WHEN v_picked THEN (p->>'from')::date END, CASE WHEN v_picked THEN (p->>'to')::date END,
            v_by, nullif(btrim(p->>'by_name'), ''))
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.books_saved_reports
    SET company = v_company, name = v_name, rows = p->>'rows', columns = p->>'columns',
        division = nullif(p->>'division', ''), location = nullif(p->>'location', ''), months = p->>'months',
        from_month = CASE WHEN v_picked THEN (p->>'from')::date END, to_month = CASE WHEN v_picked THEN (p->>'to')::date END,
        updated_at = now()
    WHERE id = v_id
    RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('state', 'saved', 'id', v_row.id, 'updated_at', v_row.updated_at);
END;
$$;

-- Deletes a saved report. p: { id, seen, by, owner }. Answers
-- { state: 'removed', name }, or 'gone', 'changed' or 'not_yours' as
-- books_saved_report_save does.
CREATE OR REPLACE FUNCTION public.books_saved_report_remove(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_row public.books_saved_reports;
BEGIN
  SELECT * INTO v_row FROM public.books_saved_reports WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'seen')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;
  IF NOT coalesce(v_row.saved_by = nullif(p->>'by', '')::uuid, false) AND (p->>'owner')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object('state', 'not_yours');
  END IF;
  DELETE FROM public.books_saved_reports WHERE id = v_id;
  RETURN jsonb_build_object('state', 'removed', 'name', v_row.name);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE public.books_saved_reports ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.books_saved_reports FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_books_split_lines(text)', 'public.gl_books_split_totals(text)', 'public.gl_books_party_totals(text, text, date, date)',
    'public.books_saved_report_save(jsonb)', 'public.books_saved_report_remove(jsonb)'
  ] LOOP
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

COMMENT ON FUNCTION public.gl_books_split_lines(text) IS 'Migration 501: one company''s journal lines on its income and expense accounts, each with its account (NetSuite id or fs:<id>), month, division and location by migration 500''s rules, and the NetSuite document and line it copies; what gl_books_split_totals and gl_books_party_totals sum. Service role only.';
COMMENT ON FUNCTION public.gl_books_split_totals(text) IS 'Migration 500, summing gl_books_split_lines since 501: one company''s journal lines on its income and expense accounts summed per account (its NetSuite id, or fs:<id>), month of entry date, division (the line''s own; on a cost or expense line without one, its item''s, else its document''s sale lines'' when they share one) and location (the line''s own key, else NetSuite''s location on the line it copies or on its document), for the report builder''s profit and loss by period, division and location. Service role only.';
COMMENT ON FUNCTION public.gl_books_party_totals(text, text, date, date) IS 'Migration 501: gl_books_split_lines in the months from p_from through p_to summed per account, month, division, location and customer or vendor (p_kind: NetSuite''s name on the line it copies when its customer or vendor list has it, else the one its document''s lines name, else null), with the names, for the report builder''s rows by customer or vendor. Service role only.';
COMMENT ON TABLE books_saved_reports IS 'Migration 501: the report builder''s reports saved by name, per company: rows, columns, filters and months (picked, or moving with the calendar). Anyone who opens the books saves one; its saver or a super admin changes or deletes it (books_saved_report_save, books_saved_report_remove). Service-role write and read.';
