-- Migration 367: FleetSuite's own books, part 6 — invoices posted to the
-- journal.
--
-- Owner decision 2026-10-13 (thread "Replacing NetSuite with FleetSuite"):
-- with every BMG invoice since January 2025 matching NetSuite (part 5,
-- migration 364), FleetSuite posts each one to its own journal with the
-- invoice rule, once. When NetSuite changes an invoice, FleetSuite reverses
-- its entry and posts the new one; when NetSuite voids or deletes it, the
-- entry is reversed. The job is src/lib/books/invoice-posting.ts. Until a
-- company's books go live the journal can still be emptied and posted again
-- (gl_reset_journal, migration 359).
--
-- This adds:
--   * gl_invoice_postings: what the journal holds for each invoice — the
--     entry that stands, its lines, every earlier entry and what reversed
--     it — and what the copy of NetSuite's invoices says of the invoice now.
--   * gl_repost_entry: replaces a document's entry in one transaction, so an
--     invoice is never left with its old entry reversed and no new one.
--   * gl_invoice_month (migration 364) also returns each invoice's customer
--     in FleetSuite, for the receivable line.
-- No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- page's API.

-- One company's NetSuite invoices dated in one month, as migration 364
-- returns them, plus `customer_id`: the FleetSuite customer the ledger
-- mirror matched the invoice's NetSuite customer to (NULL when it hasn't).
CREATE OR REPLACE FUNCTION public.gl_invoice_month(p_company TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH month_invoices AS (
    SELECT i.id, i.external_ref, i.doc_number, i.doc_date, i.total, i.voided, i.party_name, i.customer_id,
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

-- What one company's journal holds for its NetSuite invoices: every invoice
-- with an entry (or only those in p_source_ids, NetSuite's invoice ids),
-- each with
--   entries     how many entries it has had, so the next one's key is new;
--   unreversed  the ids of its entries that nothing reversed, newest first:
--               normally just the one that stands;
--   current     the newest of those with its date and, when p_lines, its
--               lines (account as NetSuite's id, amounts as decimal strings);
--   history     every entry, oldest first, and the entry that reversed it;
--   invoice     what the copy of NetSuite's invoices says of it now
--               (number, deleted, voided), NULL when the copy has none.
CREATE OR REPLACE FUNCTION public.gl_invoice_postings(p_company TEXT, p_source_ids TEXT[], p_lines BOOLEAN)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH entries AS (
    SELECT e.id, e.entry_no, e.entry_date, e.source_id, r.entry_no AS reversed_by
    FROM public.gl_entries e
    JOIN public.gl_companies c ON c.id = e.company_id
    LEFT JOIN public.gl_entries r ON r.reverses_entry_id = e.id
    WHERE c.code = p_company
      AND e.source_type = 'invoice'
      AND e.source_id IS NOT NULL
      AND (p_source_ids IS NULL OR e.source_id = ANY (p_source_ids))
  ),
  docs AS (
    SELECT source_id,
           count(*) AS entries,
           array_agg(id ORDER BY entry_no DESC) FILTER (WHERE reversed_by IS NULL) AS unreversed,
           jsonb_agg(jsonb_build_object(
             'entry_no', entry_no,
             'entry_date', to_char(entry_date, 'YYYY-MM-DD'),
             'reversed_by', reversed_by
           ) ORDER BY entry_no) AS history
    FROM entries
    GROUP BY source_id
  )
  SELECT jsonb_build_object('invoices', coalesce(jsonb_agg(jsonb_build_object(
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
      WHERE i.source = 'netsuite' AND i.doc_type = 'invoice' AND i.external_ref = d.source_id
      ORDER BY i.deleted_at DESC NULLS FIRST, i.id
      LIMIT 1
    )
  ) ORDER BY d.source_id), '[]'::jsonb))
  FROM docs d
$$;

-- Replaces a document's entry: reverses p_entry_id (dated as it was, with
-- p_memo) and posts p, as gl_post_entry takes it, in one transaction. The
-- entry must be the same document's, in the same company, and p's key must
-- be new; otherwise nothing changes.
CREATE OR REPLACE FUNCTION public.gl_repost_entry(p_entry_id UUID, p_memo TEXT, p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_orig public.gl_entries%ROWTYPE;
  v_company TEXT;
  v_reversal JSONB;
  v_entry JSONB;
BEGIN
  SELECT * INTO v_orig FROM public.gl_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: no entry %', p_entry_id;
  END IF;
  SELECT code INTO v_company FROM public.gl_companies WHERE id = v_orig.company_id;
  IF v_company IS DISTINCT FROM p->>'company'
     OR v_orig.source_type IS DISTINCT FROM p->>'source_type'
     OR v_orig.source_id IS DISTINCT FROM nullif(p->>'source_id', '') THEN
    RAISE EXCEPTION 'gl: entry % is another document''s, so it isn''t replaced', v_orig.entry_no;
  END IF;

  v_reversal := public.gl_reverse_entry(
    p_entry_id, NULL, p_memo, nullif(p->>'posted_by', '')::uuid, nullif(p->>'posted_by_name', '')
  );
  v_entry := public.gl_post_entry(p);
  IF (v_entry->>'already_posted')::boolean THEN
    RAISE EXCEPTION 'gl: % has already posted, so entry % stays as it is', p->>'idempotency_key', v_orig.entry_no;
  END IF;
  RETURN jsonb_build_object('reversal', v_reversal, 'entry', v_entry);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.gl_invoice_month(text, date)',
    'public.gl_invoice_postings(text, text[], boolean)',
    'public.gl_repost_entry(uuid, text, jsonb)'
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

COMMENT ON FUNCTION public.gl_invoice_month(text, date) IS 'Migrations 364 and 367: one company''s NetSuite invoices dated in one month, with their customer in FleetSuite, their mirrored lines (migration 314), the GL lines NetSuite posted for them (migration 361) and the copied items and tax codes they name (migration 363), for the invoice rule. Service role only.';
COMMENT ON FUNCTION public.gl_invoice_postings(text, text[], boolean) IS 'Migration 367: what one company''s journal holds for its NetSuite invoices (the entry that stands and its lines, every earlier entry and its reversal) and what the copy of NetSuite''s invoices says of each now. Service role only.';
COMMENT ON FUNCTION public.gl_repost_entry(uuid, text, jsonb) IS 'Migration 367: reverses a document''s entry and posts its new one in one transaction. Service role only.';
