-- Migration 386: FleetSuite's own books, part 11 — vendor bills and bill
-- credits posted to the journal.
--
-- Owner decision 2026-10-16 (thread "Replacing NetSuite with FleetSuite"):
-- after the bills copy and check (migrations 384 and 385), vendor bills and
-- bill credits post to FleetSuite's journal with the bill rule, bill@1
-- (src/lib/books/bill-rule.ts), the way invoices do (migration 367): once
-- each, in the month NetSuite booked it to (migration 380), reversed and
-- posted again when NetSuite changes one, reversed when NetSuite voids one
-- or no longer has it. The job is the invoice posting job
-- (src/lib/books/invoice-posting.ts). A bill's entries are filed as
-- vendor_bill and keyed vendor_bill:<NetSuite id>:<n>, a bill credit's as
-- vendor_credit. The payables line carries the vendor: its NetSuite internal
-- id, in gl_lines.vendor_ref.
--
-- This adds one read, gl_bill_postings, the bills' counterpart of
-- gl_deposit_postings (migration 383), and replaces one, with what it
-- returned before unchanged:
--   * gl_books_difference_documents (migration 377, as 383 left it) also
--     says what the copy of NetSuite's bills holds for a bill or bill credit
--     that differs: its number, vendor, and whether it's voided or gone.
-- No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- pages' APIs.

-- What one company's journal holds for its NetSuite vendor bills and bill
-- credits: every one with an entry (or only those in p_source_ids, NetSuite's
-- ids), each with
--   source_type 'vendor_bill' or 'vendor_credit';
--   entries     how many entries it has had, so the next one's key is new;
--   unreversed  the ids of its entries that nothing reversed, newest first:
--               normally just the one that stands;
--   current     the newest of those with its date and, when p_lines, its
--               lines (account as NetSuite's id, amounts as decimal strings,
--               the vendor on the payables line);
--   history     every entry, oldest first, and the entry that reversed it;
--   bill        what the copy of NetSuite's bills (migration 384) says of it
--               now: number, deleted (NetSuite no longer lists it) and
--               voided; NULL when the copy has none.
CREATE OR REPLACE FUNCTION public.gl_bill_postings(p_company TEXT, p_source_ids TEXT[], p_lines BOOLEAN)
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
      AND e.source_type IN ('vendor_bill', 'vendor_credit')
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
  SELECT jsonb_build_object('bills', coalesce(jsonb_agg(jsonb_build_object(
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
    'bill', (
      SELECT jsonb_build_object('number', x.tranid, 'deleted', x.gone_at IS NOT NULL, 'voided', x.voided)
      FROM public.gl_netsuite_bills x
      WHERE x.netsuite_id = d.source_id
    )
  ) ORDER BY d.source_id, d.source_type), '[]'::jsonb))
  FROM docs d
$$;

-- One month's documents whose FleetSuite entries don't come to what NetSuite
-- posted for them, as migration 377 lists them. `copy` now also covers vendor
-- bills and bill credits (p_kinds 'vendor_bill' and 'vendor_credit'), from
-- the copy of NetSuite's bills (migration 384): number, vendor (in
-- `customer`, the document's other party), voided, and deleted when NetSuite
-- no longer lists it.
CREATE OR REPLACE FUNCTION public.gl_books_difference_documents(p_company TEXT, p_month DATE, p_kinds JSONB, p_limit INTEGER)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  kinds AS (
    SELECT key AS kind, value AS tran_type
    FROM jsonb_each_text(CASE WHEN jsonb_typeof(p_kinds) = 'object' THEN p_kinds ELSE '{}'::jsonb END)
  ),
  cost AS (
    SELECT transaction_id, line_id FROM public.gl_netsuite_cost_lines(p_company, p_month)
  ),
  ns AS (
    SELECT k.kind, l.transaction_id AS doc, l.netsuite_account_id AS account, sum(l.debit) - sum(l.credit) AS net
    FROM public.gl_netsuite_lines l
    JOIN public.gl_netsuite_transactions t ON t.netsuite_id = l.transaction_id
    JOIN kinds k ON k.tran_type = t.tran_type
    LEFT JOIN cost c ON c.transaction_id = l.transaction_id AND c.line_id = l.line_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.posting_month = p_month
      AND c.line_id IS NULL
    GROUP BY 1, 2, 3
  ),
  fs AS (
    SELECT coalesce(o.source_type, e.source_type) AS kind,
           coalesce(o.source_id, e.source_id) AS doc,
           coalesce(a.netsuite_account_id, 'fs:' || a.id::text) AS account,
           sum(l.debit) - sum(l.credit) AS net
    FROM public.gl_lines l
    JOIN public.gl_entries e ON e.id = l.entry_id
    LEFT JOIN public.gl_entries o ON o.id = e.reverses_entry_id
    JOIN public.gl_accounts a ON a.id = l.account_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.entry_date >= p_month
      AND l.entry_date < (p_month + interval '1 month')::date
      AND coalesce(o.source_type, e.source_type) IN (SELECT kind FROM kinds)
      AND coalesce(o.source_id, e.source_id) IS NOT NULL
    GROUP BY 1, 2, 3
  ),
  sides AS (
    SELECT coalesce(n.kind, f.kind) AS kind,
           coalesce(n.doc, f.doc) AS doc,
           coalesce(n.account, f.account) AS account,
           coalesce(n.net, 0) AS netsuite,
           coalesce(f.net, 0) AS fleetsuite
    FROM ns n
    FULL JOIN fs f ON f.kind = n.kind AND f.doc = n.doc AND f.account = n.account
  ),
  differing AS (
    SELECT kind, doc, sum(abs(fleetsuite - netsuite)) AS gap
    FROM sides
    GROUP BY kind, doc
    HAVING bool_or(fleetsuite <> netsuite)
  ),
  picked AS (
    SELECT kind, doc, gap
    FROM differing
    ORDER BY gap DESC, kind, doc
    LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
  )
  SELECT jsonb_build_object(
    'counts', (
      SELECT coalesce(jsonb_object_agg(x.kind, x.n), '{}'::jsonb)
      FROM (SELECT kind, count(*) AS n FROM differing GROUP BY kind) x
    ),
    'documents', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'kind', p.kind,
        'netsuite_id', p.doc,
        'lines', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'account', s.account, 'netsuite', s.netsuite::text, 'fleetsuite', s.fleetsuite::text
          ) ORDER BY s.account), '[]'::jsonb)
          FROM sides s
          WHERE s.kind = p.kind AND s.doc = p.doc AND (s.netsuite <> 0 OR s.fleetsuite <> 0)
        ),
        'netsuite', (
          SELECT jsonb_build_object(
            'type', t.tran_type,
            'number', t.tranid,
            'date', to_char(t.trandate, 'YYYY-MM-DD'),
            'month', CASE WHEN EXISTS (
              SELECT 1 FROM public.gl_netsuite_lines l
              WHERE l.transaction_id = t.netsuite_id AND l.company_id = (SELECT id FROM company)
            ) THEN to_char(t.posting_month, 'YYYY-MM-DD') END
          )
          FROM public.gl_netsuite_transactions t
          WHERE t.netsuite_id = p.doc
        ),
        'fleetsuite', (
          SELECT jsonb_build_object(
            'entries', count(*),
            'standing', (
              SELECT jsonb_build_object('entry_no', s.entry_no, 'date', to_char(s.entry_date, 'YYYY-MM-DD'))
              FROM public.gl_entries s
              WHERE s.company_id = (SELECT id FROM company)
                AND s.source_type = p.kind
                AND s.source_id = p.doc
                AND NOT EXISTS (SELECT 1 FROM public.gl_entries r WHERE r.reverses_entry_id = s.id)
              ORDER BY s.entry_no DESC
              LIMIT 1
            )
          )
          FROM public.gl_entries e
          WHERE e.company_id = (SELECT id FROM company) AND e.source_type = p.kind AND e.source_id = p.doc
        ),
        'copy', (
          SELECT jsonb_build_object('number', m.number, 'customer', m.customer, 'voided', m.voided, 'deleted', m.deleted_at IS NOT NULL)
          FROM (
            SELECT i.doc_number AS number, i.party_name AS customer, i.voided, i.deleted_at, i.id
            FROM public.ledger_invoices i
            WHERE p.kind IN ('invoice', 'credit_memo')
              AND i.source = 'netsuite' AND i.doc_type = p.kind AND i.external_ref = p.doc
            UNION ALL
            SELECT y.doc_number, y.party_name, y.voided, y.deleted_at, y.id
            FROM public.ledger_payments y
            WHERE p.kind = 'payment'
              AND y.source = 'netsuite' AND y.direction = 'in' AND y.party_kind = 'customer' AND y.external_ref = p.doc
            UNION ALL
            -- One row at most: the copy is keyed by NetSuite's id.
            SELECT d.tranid, d.customer_name, d.voided, d.gone_at, NULL::uuid
            FROM public.gl_netsuite_deposits d
            WHERE p.kind IN ('customer_deposit', 'deposit_application')
              AND d.netsuite_id = p.doc
            UNION ALL
            -- One row at most, as the deposits; the vendor named as gl_bill_month names it.
            SELECT b.tranid, coalesce(v.name, b.vendor_name), b.voided, b.gone_at, NULL::uuid
            FROM public.gl_netsuite_bills b
            LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = b.vendor_netsuite_id
            WHERE p.kind IN ('vendor_bill', 'vendor_credit')
              AND b.netsuite_id = p.doc
          ) m
          ORDER BY m.deleted_at DESC NULLS FIRST, m.id
          LIMIT 1
        )
      ) ORDER BY p.gap DESC, p.kind, p.doc), '[]'::jsonb)
      FROM picked p
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.gl_bill_postings(text, text[], boolean)',
    'public.gl_books_difference_documents(text, date, jsonb, integer)'
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

COMMENT ON FUNCTION public.gl_bill_postings(text, text[], boolean) IS 'Migration 386: what one company''s journal holds for its NetSuite vendor bills and bill credits (the entry that stands and its lines, every earlier entry and its reversal) and what the copy of NetSuite''s bills says of each now. Service role only.';
COMMENT ON FUNCTION public.gl_books_difference_documents(text, date, jsonb, integer) IS 'Migration 377, with 383''s deposits and 386''s bills: one month''s documents of the kinds FleetSuite posts whose entries don''t come to what NetSuite posted for them, account by account, with what each side and the copy of NetSuite''s documents say of them. Service role only.';
COMMENT ON COLUMN gl_lines.vendor_ref IS 'The vendor a line is owed to or by: its NetSuite internal id, as netsuite_vendors.netsuite_id has it, kept without a foreign key. Set on a vendor bill''s or bill credit''s payables line (migration 386). NULL = no vendor.';
