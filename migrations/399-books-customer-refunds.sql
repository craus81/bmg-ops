-- Migration 399: FleetSuite's own books, part 17 — NetSuite's customer
-- refunds posted to the journal with its bank deposits and transfers.
--
-- Owner decision 2026-10-18 (thread "Replacing NetSuite with FleetSuite",
-- "Build it" on posting customer refunds the way bank deposits post): a
-- customer refund (NetSuite's CustRfnd transaction) pays a customer back a
-- credit they hold, out of Undeposited Funds or a bank account, debiting
-- receivables. The balance sheet check showed why it matters: with the
-- payment posted and its refund not, FleetSuite's receivables ran low and
-- Undeposited Funds or the bank high. Every line of a refund is already in
-- the copy of NetSuite's general ledger (migration 361), so it posts from
-- that copy as a bank deposit or transfer does (migration 394), with the
-- rule bank@1 (src/lib/books/bank-rule.ts): its lines for a company, to the
-- same accounts and for the same amounts, are that company's entry, each
-- line keeping its memo with its name in front, the receivables line
-- carrying the customer. Its entries are filed as customer_refund, keyed
-- customer_refund:<NetSuite id>:<n>, in the month NetSuite booked it into,
-- reversed and posted again when NetSuite changes one, reversed when the copy
-- no longer holds a line of it for the company.
--
-- This replaces migration 394's two reads, each now taking refunds too:
--   * gl_bank_month gives a month's CustRfnd transactions with its Deposit
--     and Transfer ones;
--   * gl_bank_postings gives what the journal holds for customer_refund
--     entries with bank_deposit and bank_transfer ones, a refund being
--     deleted once the copy holds no CustRfnd line of it for the company.
-- gl_books_difference_documents (migration 377, as 395 left it) is left as
-- it is: it reads a refund's number and NetSuite's lines from the GL copy,
-- as it does a bank deposit's. No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- pages' APIs.

-- One company's NetSuite bank deposits, transfers and customer refunds
-- booked into one month, as the copy of NetSuite's GL holds them: every
-- Deposit, Transfer and CustRfnd transaction with a line for the company
-- whose posting month is p_month's, by date, each with
--   netsuite_id, type ('Deposit', 'Transfer' or 'CustRfnd'), number
--   (NetSuite's, NULL when it has none), date and posting_month;
--   companies  every company the copy has lines of it for;
--   lines      its lines for the company in NetSuite's order, as
--              gl_journal_month (migration 393) gives a journal entry's.
CREATE OR REPLACE FUNCTION public.gl_bank_month(p_company TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  month_documents AS (
    SELECT t.netsuite_id, t.tran_type, t.tranid, t.trandate, t.posting_month
    FROM public.gl_netsuite_transactions t
    WHERE t.tran_type IN ('Deposit', 'Transfer', 'CustRfnd')
      AND t.posting_month = date_trunc('month', p_month)::date
      AND EXISTS (
        SELECT 1 FROM public.gl_netsuite_lines l
        WHERE l.transaction_id = t.netsuite_id AND l.company_id = (SELECT id FROM company)
      )
  )
  SELECT jsonb_build_object('documents', coalesce(jsonb_agg(jsonb_build_object(
    'netsuite_id', m.netsuite_id,
    'type', m.tran_type,
    'number', m.tranid,
    'date', to_char(m.trandate, 'YYYY-MM-DD'),
    'posting_month', to_char(m.posting_month, 'YYYY-MM-DD'),
    'companies', (
      SELECT to_jsonb(array_agg(DISTINCT c.code ORDER BY c.code))
      FROM public.gl_netsuite_lines l
      JOIN public.gl_companies c ON c.id = l.company_id
      WHERE l.transaction_id = m.netsuite_id
    ),
    'lines', (
      SELECT jsonb_agg(jsonb_build_object(
        'line_id', l.line_id,
        'account', l.netsuite_account_id,
        'debit', l.debit::text,
        'credit', l.credit::text,
        'memo', l.memo,
        'entity_id', l.entity_id,
        'name', coalesce(v.name, lc.display_name),
        'customer_id', CASE WHEN lc.match_status = 'exact' THEN lc.customer_id END
      ) ORDER BY l.line_id::bigint)
      FROM public.gl_netsuite_lines l
      LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = l.entity_id
      LEFT JOIN public.ledger_customers lc ON lc.source = 'netsuite' AND lc.external_id = 'customer/' || l.entity_id
      WHERE l.transaction_id = m.netsuite_id
        AND l.company_id = (SELECT id FROM company)
    )
  ) ORDER BY m.trandate, m.tranid, m.netsuite_id::bigint), '[]'::jsonb))
  FROM month_documents m
$$;

-- What one company's journal holds for its NetSuite bank deposits,
-- transfers and customer refunds: every one with an entry (or only those in
-- p_source_ids, NetSuite's ids), each with source_type ('bank_deposit',
-- 'bank_transfer' or 'customer_refund'), entries, unreversed, current and
-- history as gl_journal_postings (migration 393) gives them, and
--   document  what the copy of NetSuite's GL says of it now: its number (the
--             memo of its newest entry, which is the number, once the copy no
--             longer has it) and deleted, when the copy holds no line of it
--             of its own type for the company: NetSuite deleted it or moved
--             it to the other company.
CREATE OR REPLACE FUNCTION public.gl_bank_postings(p_company TEXT, p_source_ids TEXT[], p_lines BOOLEAN)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH entries AS (
    SELECT e.id, e.company_id, e.entry_no, e.entry_date, e.source_type, e.source_id, e.memo, r.entry_no AS reversed_by
    FROM public.gl_entries e
    JOIN public.gl_companies c ON c.id = e.company_id
    LEFT JOIN public.gl_entries r ON r.reverses_entry_id = e.id
    WHERE c.code = p_company
      AND e.source_type IN ('bank_deposit', 'bank_transfer', 'customer_refund')
      AND e.source_id IS NOT NULL
      AND (p_source_ids IS NULL OR e.source_id = ANY (p_source_ids))
  ),
  docs AS (
    SELECT source_type,
           source_id,
           company_id,
           count(*) AS entries,
           array_agg(id ORDER BY entry_no DESC) FILTER (WHERE reversed_by IS NULL) AS unreversed,
           (array_agg(memo ORDER BY entry_no DESC))[1] AS memo,
           jsonb_agg(jsonb_build_object(
             'entry_no', entry_no,
             'entry_date', to_char(entry_date, 'YYYY-MM-DD'),
             'reversed_by', reversed_by
           ) ORDER BY entry_no) AS history
    FROM entries
    GROUP BY source_type, source_id, company_id
  )
  SELECT jsonb_build_object('documents', coalesce(jsonb_agg(jsonb_build_object(
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
            'customer_id', l.customer_id,
            'vendor_ref', l.vendor_ref
          ) ORDER BY l.line_no), '[]'::jsonb)
          FROM public.gl_lines l
          JOIN public.gl_accounts a ON a.id = l.account_id
          WHERE l.entry_id = e.id
        ) END
      )
      FROM public.gl_entries e
      WHERE e.id = d.unreversed[1]
    ),
    'document', jsonb_build_object(
      'number', coalesce((SELECT t.tranid FROM public.gl_netsuite_transactions t WHERE t.netsuite_id = d.source_id), d.memo),
      'deleted', NOT EXISTS (
        SELECT 1
        FROM public.gl_netsuite_lines l
        JOIN public.gl_netsuite_transactions t ON t.netsuite_id = l.transaction_id
        WHERE l.transaction_id = d.source_id
          AND l.company_id = d.company_id
          AND t.tran_type = CASE d.source_type
            WHEN 'bank_deposit' THEN 'Deposit'
            WHEN 'bank_transfer' THEN 'Transfer'
            WHEN 'customer_refund' THEN 'CustRfnd'
          END
      )
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
    'public.gl_bank_month(text, date)',
    'public.gl_bank_postings(text, text[], boolean)'
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

COMMENT ON FUNCTION public.gl_bank_month(text, date) IS 'Migrations 394 and 399: one company''s NetSuite bank deposits, transfers and customer refunds booked into one month, from the copy of NetSuite''s GL (migration 361), each with its type, its lines for the company, their names and any FleetSuite customer, for the bank rule''s check and posting. Service role only.';
COMMENT ON FUNCTION public.gl_bank_postings(text, text[], boolean) IS 'Migrations 394 and 399: what one company''s journal holds for its NetSuite bank deposits, transfers and customer refunds (the entry that stands and its lines, every earlier entry and its reversal) and what the copy of NetSuite''s GL says of each now. Service role only.';
COMMENT ON COLUMN gl_lines.vendor_ref IS 'The vendor a line is owed to or by: its NetSuite internal id, as netsuite_vendors.netsuite_id has it, kept without a foreign key. Set on the payables line of a vendor bill or bill credit (migration 386) and of a bill payment (migration 390), and on the payables lines of a NetSuite journal entry (migration 393), bank deposit or transfer (migration 394), stock document (migration 395) or customer refund (migration 399). NULL = no vendor.';
