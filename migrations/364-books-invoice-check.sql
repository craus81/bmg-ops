-- Migration 364: FleetSuite's own books, part 5 — invoices, the first
-- posting rule, checked against NetSuite before anything posts.
--
-- Owner decision 2026-10-11 (thread "Replacing NetSuite with FleetSuite"):
-- the first posting rule is the invoice's. For every NetSuite invoice
-- FleetSuite works out its own entry (accounts receivable for the total,
-- each line to its item's income account, sales tax to the account its tax
-- code posts to) and checks it line by line against the GL lines NetSuite
-- posted for the same invoice. Nothing is posted to the journal yet; the
-- rule itself is src/lib/books/invoice-rule.ts.
--
-- This adds one read: a month of invoices with what the check needs. The
-- invoices and their lines come from the ledger mirror (migration 314), the
-- GL lines from the copy of NetSuite's general ledger (migration 361), and
-- the items from the copied NetSuite lists (migration 363). No table is
-- added or changed.
--
-- Caller: the service role only, from the super admin page's API.

-- One company's NetSuite invoices dated in one month, each with its lines as
-- the mirror copied them and the GL lines NetSuite posted for it, plus the
-- copied items and tax codes those lines name. An invoice is the company's
-- when NetSuite posted a GL line of it to that company. Invoices with no GL
-- line in the copy at all come back for every company (`companies` empty):
-- NetSuite hasn't posted them, or the copy hasn't reached them yet.
--
-- Returns { invoices: [{ id, netsuite_id, number, date, total, voided,
--   customer, lines_copied, companies: ['BMG'],
--   lines: [{ line_id, line_no, kind, item_id, item_number, amount, netamount }],
--   netsuite: [{ line_id, account, debit, credit }] }],
--   items: [{ kind: 'item' | 'tax_code', netsuite_id, name, active, gone,
--             item_type, income_account, asset_account }] }.
-- Amounts are decimal strings; netamount is NetSuite's own, signed (a sale
-- is negative), and NULL when the mirror didn't keep it.
CREATE OR REPLACE FUNCTION public.gl_invoice_month(p_company TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH month_invoices AS (
    SELECT i.id, i.external_ref, i.doc_number, i.doc_date, i.total, i.voided, i.party_name,
           i.lines_synced_at IS NOT NULL AS lines_copied
    FROM public.ledger_invoices i
    WHERE i.source = 'netsuite'
      AND i.doc_type = 'invoice'
      AND i.deleted_at IS NULL
      AND i.doc_date >= date_trunc('month', p_month)::date
      AND i.doc_date < (date_trunc('month', p_month) + interval '1 month')::date
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
        'netsuite_id', x.external_ref,
        'number', x.doc_number,
        'date', to_char(x.doc_date, 'YYYY-MM-DD'),
        'total', x.total::text,
        'voided', x.voided,
        'customer', x.party_name,
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

COMMENT ON FUNCTION public.gl_invoice_month(text, date) IS 'Migration 364: one company''s NetSuite invoices dated in one month, with their mirrored lines (migration 314), the GL lines NetSuite posted for them (migration 361) and the copied items and tax codes they name (migration 363), for the invoice rule''s check. Service role only.';
