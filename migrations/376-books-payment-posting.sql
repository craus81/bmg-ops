-- Migration 376: FleetSuite's own books, part 8 — customer payments posted
-- to the journal.
--
-- Owner decision 2026-10-15 (thread "Replacing NetSuite with FleetSuite"):
-- after the payment check (migration 374) and the discount fix, payments
-- post to FleetSuite's journal with the payment rule, payment@1
-- (src/lib/books/payment-rule.ts), the way invoices and credit memos do
-- (migrations 367 and 370): once each, reversed and posted again when
-- NetSuite changes one, reversed when NetSuite voids or deletes it. The job
-- is the invoice posting job (src/lib/books/invoice-posting.ts), keyed
-- payment:<NetSuite id>:<n>. The ledger mirror now marks payments NetSuite
-- deleted (src/lib/ledger/netsuite-mirror.ts), so a deleted one's entry is
-- reversed rather than left standing.
--
-- This adds one read, gl_payment_postings, the payments' counterpart of
-- gl_invoice_postings. No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- page's API.

-- What one company's journal holds for its NetSuite customer payments: every
-- payment with an entry (or only those in p_source_ids, NetSuite's payment
-- ids), each with
--   entries     how many entries it has had, so the next one's key is new;
--   unreversed  the ids of its entries that nothing reversed, newest first:
--               normally just the one that stands;
--   current     the newest of those with its date and, when p_lines, its
--               lines (account as NetSuite's id, amounts as decimal strings);
--   history     every entry, oldest first, and the entry that reversed it;
--   payment     what the ledger mirror's copy says of it now (number,
--               deleted, voided), NULL when the copy has none.
CREATE OR REPLACE FUNCTION public.gl_payment_postings(p_company TEXT, p_source_ids TEXT[], p_lines BOOLEAN)
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
      AND e.source_type = 'payment'
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
  SELECT jsonb_build_object('payments', coalesce(jsonb_agg(jsonb_build_object(
    'source_type', 'payment',
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
    'payment', (
      SELECT jsonb_build_object('number', p.doc_number, 'deleted', p.deleted_at IS NOT NULL, 'voided', p.voided)
      FROM public.ledger_payments p
      WHERE p.source = 'netsuite' AND p.external_ref = d.source_id
        AND p.direction = 'in' AND p.party_kind = 'customer'
      ORDER BY p.deleted_at DESC NULLS FIRST, p.id
      LIMIT 1
    )
  ) ORDER BY d.source_id), '[]'::jsonb))
  FROM docs d
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.gl_payment_postings(text, text[], boolean) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_payment_postings(text, text[], boolean) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gl_payment_postings(text, text[], boolean) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_payment_postings(text, text[], boolean) IS 'Migration 376: what one company''s journal holds for its NetSuite customer payments (the entry that stands and its lines, every earlier entry and its reversal) and what the ledger mirror''s copy says of each now. Service role only.';
