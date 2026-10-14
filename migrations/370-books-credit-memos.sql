-- Migration 370: FleetSuite's own books, part 7 — credit memos, checked
-- against NetSuite and posted to the journal like invoices.
--
-- Owner decision 2026-10-14 (thread "Replacing NetSuite with FleetSuite"):
-- the next posting rule is the credit memo's, the invoice rule the other way
-- round (revenue and sales tax debited, receivables credited). Every NetSuite
-- credit memo is checked line by line against what NetSuite posted for it on
-- the invoices page, and posted to the journal by the invoice posting job
-- (src/lib/books/invoice-posting.ts), keyed credit_memo:<NetSuite id>:<n>.
--
-- This changes two reads (migrations 364 and 367) so they take in credit
-- memos as well as invoices, and say which each one is:
--   * gl_invoice_month returns the month's credit memos too, each with its
--     `doc_type` ('invoice' or 'credit_memo');
--   * gl_invoice_postings reads entries of either kind (`source_type`), and
--     looks each one up in the copy of NetSuite's documents of its own kind.
-- No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- page's API.

-- One company's NetSuite invoices and credit memos dated in one month, as
-- migrations 364 and 367 return the invoices, plus `doc_type`. The mirror
-- keeps NetSuite's signed `netamount` on each line, so a credit memo's lines
-- come back the other way round from an invoice's (a sale is negative on an
-- invoice, positive on a credit memo); `total` is unsigned for both.
CREATE OR REPLACE FUNCTION public.gl_invoice_month(p_company TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH month_invoices AS (
    SELECT i.id, i.doc_type, i.external_ref, i.doc_number, i.doc_date, i.total, i.voided, i.party_name, i.customer_id,
           i.lines_synced_at IS NOT NULL AS lines_copied
    FROM public.ledger_invoices i
    WHERE i.source = 'netsuite'
      AND i.doc_type IN ('invoice', 'credit_memo')
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
        'doc_type', x.doc_type,
        'netsuite_id', x.external_ref,
        'number', x.doc_number,
        'date', to_char(x.doc_date, 'YYYY-MM-DD'),
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

-- What one company's journal holds for its NetSuite invoices and credit
-- memos, as migration 367 returns it for invoices, plus `source_type` on
-- each ('invoice' or 'credit_memo'). `invoice` is what the copy of NetSuite's
-- documents of that kind says of it now.
CREATE OR REPLACE FUNCTION public.gl_invoice_postings(p_company TEXT, p_source_ids TEXT[], p_lines BOOLEAN)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH entries AS (
    SELECT e.id, e.entry_no, e.entry_date, e.source_type, e.source_id, r.entry_no AS reversed_by
    FROM public.gl_entries e
    JOIN public.gl_companies c ON c.id = e.company_id
    LEFT JOIN public.gl_entries r ON r.reverses_entry_id = e.id
    WHERE c.code = p_company
      AND e.source_type IN ('invoice', 'credit_memo')
      AND e.source_id IS NOT NULL
      AND (p_source_ids IS NULL OR e.source_id = ANY (p_source_ids))
  ),
  docs AS (
    SELECT source_type,
           source_id,
           count(*) AS entries,
           array_agg(id ORDER BY entry_no DESC) FILTER (WHERE reversed_by IS NULL) AS unreversed,
           jsonb_agg(jsonb_build_object(
             'entry_no', entry_no,
             'entry_date', to_char(entry_date, 'YYYY-MM-DD'),
             'reversed_by', reversed_by
           ) ORDER BY entry_no) AS history
    FROM entries
    GROUP BY source_type, source_id
  )
  SELECT jsonb_build_object('invoices', coalesce(jsonb_agg(jsonb_build_object(
    'source_type', d.source_type,
    'source_id', d.source_id,
    'entries', d.entries,
    'unreversed', to_jsonb(coalesce(d.unreversed, ARRAY[]::uuid[])),
    'history', d.history,
    'current', (
      SELECT jsonb_build_object(
        'id', e.id,
        'entry_no', e.entry_no,
        'entry_date', to_char(e.entry_date, 'YYYY-MM-DD'),
        'lines', CASE WHEN p_lines THEN (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'account', a.netsuite_account_id,
            'debit', l.debit::text,
            'credit', l.credit::text,
            'division', l.division,
            'source_line_ref', l.source_line_ref,
            'customer_id', l.customer_id
          ) ORDER BY l.line_no), '[]'::jsonb)
          FROM public.gl_lines l
          JOIN public.gl_accounts a ON a.id = l.account_id
          WHERE l.entry_id = e.id
        ) END
      )
      FROM public.gl_entries e
      WHERE e.id = d.unreversed[1]
    ),
    'invoice', (
      SELECT jsonb_build_object('number', i.doc_number, 'deleted', i.deleted_at IS NOT NULL, 'voided', i.voided)
      FROM public.ledger_invoices i
      WHERE i.source = 'netsuite' AND i.doc_type = d.source_type AND i.external_ref = d.source_id
      ORDER BY i.deleted_at DESC NULLS FIRST, i.id
      LIMIT 1
    )
  ) ORDER BY d.source_id, d.source_type), '[]'::jsonb))
  FROM docs d
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.gl_invoice_month(text, date)',
    'public.gl_invoice_postings(text, text[], boolean)'
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

COMMENT ON FUNCTION public.gl_invoice_month(text, date) IS 'Migrations 364, 367 and 370: one company''s NetSuite invoices and credit memos dated in one month, each with its kind (doc_type), its customer in FleetSuite, its mirrored lines (migration 314), the GL lines NetSuite posted for it (migration 361) and the copied items and tax codes they name (migration 363), for the invoice and credit memo rules. Service role only.';
COMMENT ON FUNCTION public.gl_invoice_postings(text, text[], boolean) IS 'Migrations 367 and 370: what one company''s journal holds for its NetSuite invoices and credit memos (the entry that stands and its lines, every earlier entry and its reversal) and what the copy of NetSuite''s documents says of each now. Service role only.';
