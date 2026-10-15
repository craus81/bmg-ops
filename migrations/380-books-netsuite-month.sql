-- Migration 380: FleetSuite's own books — invoices and credit memos post in
-- the month NetSuite booked them to.
--
-- Owner decision 2026-10-15 (thread "Replacing NetSuite with FleetSuite"):
-- the Differences vs NetSuite page (migration 377) showed documents NetSuite
-- booked into a month other than their own date's. Invoices dated in 2023 and
-- 2024 that NetSuite carried into January 2025 were skipped, since FleetSuite's
-- books start then. An invoice entered after its own month had closed sat in
-- that month in FleetSuite but in a later one in NetSuite. FleetSuite now
-- posts each invoice and credit memo in the month NetSuite booked it to. The
-- entry keeps the document's own date when it falls in that month, and
-- otherwise takes the month's first day (its last, when NetSuite booked it
-- into an earlier month). That date is worked out by entryDate in
-- src/lib/books/invoice-check.ts.
--
-- This changes one read (migrations 364, 367 and 370). gl_invoice_month now
-- returns the documents NetSuite booked into the month, whatever their date,
-- and the ones dated in it that the copy of NetSuite's GL hasn't booked into
-- any month (not posted in NetSuite, or not copied yet). Each one carries
-- `posting_month`, the month NetSuite booked it to, null when the copy has
-- none of it. No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- page's API.

-- One company's NetSuite invoices and credit memos for one month, as
-- migration 370 returns them, plus `posting_month`. A document is in the
-- month NetSuite booked it to (gl_netsuite_transactions.posting_month), or,
-- when the copy of NetSuite's GL has none of it, in the month of its date.
CREATE OR REPLACE FUNCTION public.gl_invoice_month(p_company TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH bounds AS (
    SELECT date_trunc('month', p_month)::date AS m_from,
           (date_trunc('month', p_month) + interval '1 month')::date AS m_to
  ),
  month_invoices AS (
    -- Dated in the month, unless NetSuite booked it into another one.
    SELECT i.id, i.doc_type, i.external_ref, i.doc_number, i.doc_date, i.total, i.voided, i.party_name, i.customer_id,
           i.lines_synced_at IS NOT NULL AS lines_copied, t.posting_month
    FROM public.ledger_invoices i
    CROSS JOIN bounds b
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = i.external_ref
    WHERE i.source = 'netsuite'
      AND i.doc_type IN ('invoice', 'credit_memo')
      AND i.deleted_at IS NULL
      AND i.doc_date >= b.m_from
      AND i.doc_date < b.m_to
      AND (t.posting_month IS NULL OR t.posting_month = b.m_from)
    UNION ALL
    -- Dated in another month, but booked by NetSuite into this one.
    SELECT i.id, i.doc_type, i.external_ref, i.doc_number, i.doc_date, i.total, i.voided, i.party_name, i.customer_id,
           i.lines_synced_at IS NOT NULL AS lines_copied, t.posting_month
    FROM public.gl_netsuite_transactions t
    CROSS JOIN bounds b
    JOIN public.ledger_invoices i ON i.source = 'netsuite' AND i.external_ref = t.netsuite_id
    WHERE t.posting_month = b.m_from
      AND i.doc_type IN ('invoice', 'credit_memo')
      AND i.deleted_at IS NULL
      AND (i.doc_date < b.m_from OR i.doc_date >= b.m_to)
  ),
  posted AS (
    SELECT m.id, array_agg(DISTINCT c.code ORDER BY c.code) AS companies
    FROM month_invoices m
    JOIN public.gl_netsuite_lines l ON l.transaction_id = m.external_ref
    JOIN public.gl_companies c ON c.id = l.company_id
    GROUP BY m.id
  ),
  picked AS (
    SELECT m.*, coalesce(p.companies, ARRAY[]::text[]) AS companies
    FROM month_invoices m
    LEFT JOIN posted p ON p.id = m.id
    WHERE p.companies IS NULL OR p_company IS NULL OR p_company = ANY (p.companies)
  )
  SELECT jsonb_build_object(
    'invoices', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id,
        'doc_type', x.doc_type,
        'netsuite_id', x.external_ref,
        'number', x.doc_number,
        'date', to_char(x.doc_date, 'YYYY-MM-DD'),
        'posting_month', to_char(x.posting_month, 'YYYY-MM-DD'),
        'total', x.total::text,
        'voided', x.voided,
        'customer', x.party_name,
        'customer_id', x.customer_id,
        'lines_copied', x.lines_copied,
        'companies', to_jsonb(x.companies),
        'lines', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'line_id', dl.line_external_id,
            'line_no', dl.line_no,
            'kind', dl.line_kind,
            'item_id', dl.item_external_id,
            'item_number', dl.item_number,
            'amount', dl.amount::text,
            'netamount', dl.raw->>'netamount'
          ) ORDER BY dl.line_no NULLS LAST, dl.line_external_id), '[]'::jsonb)
          FROM public.ledger_invoice_lines dl
          WHERE dl.document_id = x.id
        ),
        'netsuite', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'line_id', l.line_id,
            'account', l.netsuite_account_id,
            'debit', l.debit::text,
            'credit', l.credit::text
          ) ORDER BY l.line_id::bigint), '[]'::jsonb)
          FROM public.gl_netsuite_lines l
          WHERE l.transaction_id = x.external_ref
        )
      ) ORDER BY x.doc_date, x.doc_number, x.id), '[]'::jsonb)
      FROM picked x
    ),
    'items', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'kind', li.kind,
        'netsuite_id', li.netsuite_id,
        'name', li.name,
        'active', li.active,
        'gone', li.gone_at IS NOT NULL,
        'item_type', li.details->>'item_type',
        'income_account', li.details->>'income_account',
        'asset_account', li.details->>'asset_account'
      ) ORDER BY li.kind, li.netsuite_id), '[]'::jsonb)
      FROM public.gl_netsuite_lists li
      WHERE li.kind IN ('item', 'tax_code')
        AND li.netsuite_id IN (
          SELECT dl.item_external_id
          FROM public.ledger_invoice_lines dl
          JOIN picked x ON x.id = dl.document_id
          WHERE dl.item_external_id IS NOT NULL
        )
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.gl_invoice_month(text, date) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_invoice_month(text, date) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gl_invoice_month(text, date) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_invoice_month(text, date) IS 'Migrations 364, 367, 370 and 380: one company''s NetSuite invoices and credit memos for one month (those NetSuite booked into it, and those dated in it that the copy of NetSuite''s GL has booked into no month), each with its kind (doc_type), the month NetSuite booked it to (posting_month), its customer in FleetSuite, its mirrored lines (migration 314), the GL lines NetSuite posted for it (migration 361) and the copied items and tax codes they name (migration 363), for the invoice and credit memo rules. Service role only.';
