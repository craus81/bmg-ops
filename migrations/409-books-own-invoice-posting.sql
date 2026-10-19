-- Migration 409: FleetSuite's own books, part 24 — FleetSuite's own invoices
-- posted to the books.
--
-- Owner decision 2026-10-19 (thread "Replacing NetSuite with FleetSuite",
-- "Post own invoices"): the books post FleetSuite's own copy of each invoice
-- it made (migration 407) when the copy matches NetSuite's invoice, and its
-- entry comes out the same account by account; one that differs keeps
-- posting NetSuite's, since that's what the customer was billed. The posting
-- job (src/lib/books/invoice-posting.ts, src/lib/books/own-invoice-posting.ts)
-- tells which an entry was built from by its posting rule: own_invoice@1 from
-- FleetSuite's copy, invoice@1 from NetSuite's. Both are the invoice's
-- entries, `invoice:<NetSuite id>:<n>`, so nothing else that reads the books
-- changes.
--
-- This changes one read (migrations 367 and 370): gl_invoice_postings says
-- which rule made the entry that stands (`posting_rule` on `current`), for
-- the job to know when to switch and for the pages to say which copy an
-- invoice posted from. No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- pages' API.

-- What one company's journal holds for its NetSuite invoices and credit
-- memos, as migration 370 returns it, plus the rule that made the entry
-- that stands.
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
        'posting_rule', e.posting_rule,
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
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.gl_invoice_postings(text, text[], boolean) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_invoice_postings(text, text[], boolean) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gl_invoice_postings(text, text[], boolean) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_invoice_postings(text, text[], boolean) IS 'Migrations 367, 370 and 409: what one company''s journal holds for its NetSuite invoices and credit memos (the entry that stands, the rule that made it and its lines, every earlier entry and its reversal) and what the copy of NetSuite''s documents says of each now. Service role only.';
COMMENT ON TABLE gl_own_invoices IS 'Migration 407: FleetSuite''s own copy of each invoice it makes in NetSuite, worked out from what it billed by its own rules (src/lib/books/own-invoices.ts), saved only by gl_own_invoice_save, by NetSuite''s id for the invoice. Since migration 409 the books post it in place of NetSuite''s invoice when it matches it (own_invoice@1, src/lib/books/own-invoice-posting.ts). Service-role write and read.';
