-- Migration 395: FleetSuite's own books, part 15 — NetSuite's stock and its
-- cost posted to the journal.
--
-- Owner decision 2026-10-17 (thread "Replacing NetSuite with FleetSuite",
-- "Stock and cost", posted from the "Ledger copy"): the NetSuite documents
-- that move stock and book its cost post to FleetSuite's journal from the
-- copy of NetSuite's general ledger (migration 361), which already holds
-- every line of them, the way journal entries (migration 393) and bank
-- deposits and transfers (migration 394) do: item fulfillments (NetSuite's
-- ItemShip), item receipts (ItemRcpt), inventory adjustments (InvAdjst) and
-- transfers (InvTrnfr), and assembly builds (Build) and unbuilds (Unbuild),
-- and the cost lines NetSuite books on an invoice that wasn't fulfilled first
-- or a credit memo that brings stock back, which the invoice and credit memo
-- rules leave out. One's lines for a company (an invoice's or credit memo's
-- cost lines only, as gl_netsuite_cost_lines recognizes them), to the same
-- accounts and for the same amounts, are that company's entry, with the rule
-- stock@1 (src/lib/books/stock-rule.ts), so FleetSuite takes NetSuite's
-- costs as they are. The job is the invoice posting job
-- (src/lib/books/invoice-posting.ts), and they post as journal entries do:
-- once each, in the month NetSuite booked it into, reversed and posted again
-- when NetSuite changes one, reversed when the copy no longer holds a line of
-- it for the company (for an invoice or credit memo, a cost line). The
-- entries are filed as item_fulfillment, item_receipt, inventory_adjustment,
-- inventory_transfer, assembly_build, assembly_unbuild and invoice_cost (an
-- invoice's and a credit memo's cost lines alike), keyed
-- <source type>:<NetSuite id>:<n>.
--
-- This adds two reads and replaces one, with what it returned before
-- unchanged:
--   * gl_stock_month, one company's stock documents NetSuite booked into a
--     month, each with its lines for the company and their names, as
--     gl_bank_month gives bank deposits;
--   * gl_stock_postings, their counterpart of gl_bank_postings;
--   * gl_books_difference_documents (migration 377, as 392 left it) also
--     takes the kind 'cost' in p_kinds: the cost lines of NetSuite's
--     invoices and credit memos (gl_netsuite_cost_lines), which every other
--     kind leaves out, as gl_books_differences counts them. It reads a stock
--     document's number and NetSuite's lines from the GL copy, as it does a
--     journal entry's, and gives an invoice's or credit memo's cost lines the
--     copy of the invoice or credit memo (migration 314), for its customer.
-- No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- pages' APIs.

-- One company's NetSuite stock documents booked into one month, as the copy
-- of NetSuite's GL holds them: every ItemShip, ItemRcpt, InvAdjst, InvTrnfr,
-- Build and Unbuild transaction with a line for the company, and every
-- invoice and credit memo with a cost line for it (gl_netsuite_cost_lines),
-- whose posting month is p_month's, by date, each with
--   netsuite_id, type (NetSuite's transaction type), number (NetSuite's, NULL
--   when it has none), date and posting_month;
--   companies  every company the copy has lines of it for;
--   lines      its lines for the company in NetSuite's order (an invoice's or
--              credit memo's cost lines only), as gl_bank_month (migration
--              394) gives a bank deposit's.
CREATE OR REPLACE FUNCTION public.gl_stock_month(p_company TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  cost AS (
    SELECT transaction_id, line_id FROM public.gl_netsuite_cost_lines(p_company, date_trunc('month', p_month)::date)
  ),
  month_documents AS (
    SELECT t.netsuite_id, t.tran_type, t.tranid, t.trandate, t.posting_month
    FROM public.gl_netsuite_transactions t
    WHERE t.posting_month = date_trunc('month', p_month)::date
      AND (
        (t.tran_type IN ('ItemShip', 'ItemRcpt', 'InvAdjst', 'InvTrnfr', 'Build', 'Unbuild') AND EXISTS (
          SELECT 1 FROM public.gl_netsuite_lines l
          WHERE l.transaction_id = t.netsuite_id AND l.company_id = (SELECT id FROM company)
        ))
        OR t.netsuite_id IN (SELECT transaction_id FROM cost)
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
        AND (
          m.tran_type NOT IN ('CustInvc', 'CustCred')
          OR EXISTS (SELECT 1 FROM cost c WHERE c.transaction_id = l.transaction_id AND c.line_id = l.line_id)
        )
    )
  ) ORDER BY m.trandate, m.tranid, m.netsuite_id::bigint), '[]'::jsonb))
  FROM month_documents m
$$;

-- What one company's journal holds for its NetSuite stock documents: every
-- one with an entry (or only those in p_source_ids, NetSuite's ids), each
-- with source_type (item_fulfillment, item_receipt, inventory_adjustment,
-- inventory_transfer, assembly_build, assembly_unbuild or invoice_cost),
-- entries, unreversed, current and history as gl_bank_postings (migration
-- 394) gives them, and
--   document  what the copy of NetSuite's GL says of it now: its number (the
--             memo of its newest entry, which is the number, once the copy no
--             longer has it) and deleted, when the copy holds no line of it
--             for the company (for an invoice or credit memo, no cost line):
--             NetSuite deleted it, moved it to the other company, or, for an
--             invoice or credit memo, books no cost on it now.
CREATE OR REPLACE FUNCTION public.gl_stock_postings(p_company TEXT, p_source_ids TEXT[], p_lines BOOLEAN)
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
      AND e.source_type IN (
        'item_fulfillment', 'item_receipt', 'inventory_adjustment', 'inventory_transfer', 'assembly_build', 'assembly_unbuild',
        'invoice_cost'
      )
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
  ),
  kinds (source_type, tran_type) AS (
    VALUES ('item_fulfillment', 'ItemShip'), ('item_receipt', 'ItemRcpt'), ('inventory_adjustment', 'InvAdjst'),
           ('inventory_transfer', 'InvTrnfr'), ('assembly_build', 'Build'), ('assembly_unbuild', 'Unbuild')
  ),
  -- The invoices and credit memos the copy still has cost lines of for the company, read a month at a time: only the
  -- months NetSuite books the ones with entries into now.
  cost_months AS (
    SELECT DISTINCT t.posting_month
    FROM docs d
    JOIN public.gl_netsuite_transactions t ON t.netsuite_id = d.source_id
    WHERE d.source_type = 'invoice_cost'
  ),
  cost_documents AS (
    SELECT DISTINCT c.transaction_id
    FROM cost_months m
    CROSS JOIN LATERAL public.gl_netsuite_cost_lines(p_company, m.posting_month) c
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
      'deleted', CASE WHEN d.source_type = 'invoice_cost'
        THEN NOT EXISTS (SELECT 1 FROM cost_documents c WHERE c.transaction_id = d.source_id)
        ELSE NOT EXISTS (
          SELECT 1
          FROM public.gl_netsuite_lines l
          JOIN public.gl_netsuite_transactions t ON t.netsuite_id = l.transaction_id
          JOIN kinds k ON k.tran_type = t.tran_type
          WHERE l.transaction_id = d.source_id
            AND l.company_id = d.company_id
            AND k.source_type = d.source_type
        )
      END
    )
  ) ORDER BY d.source_id, d.source_type), '[]'::jsonb))
  FROM docs d
$$;

-- One month's documents whose FleetSuite entries don't come to what NetSuite
-- posted for them, as migration 377 lists them. p_kinds may now name the
-- kind 'cost' (FleetSuite's invoice_cost): NetSuite's side of it is the cost
-- lines of its invoices and credit memos (gl_netsuite_cost_lines), which
-- every other kind leaves out, as gl_books_differences counts them, and its
-- copy is the invoice's or credit memo's.
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
  -- A cost line is of the kind 'cost' and of no other, as gl_books_differences counts it.
  ns AS (
    SELECT k.kind, l.transaction_id AS doc, l.netsuite_account_id AS account, sum(l.debit) - sum(l.credit) AS net
    FROM public.gl_netsuite_lines l
    JOIN public.gl_netsuite_transactions t ON t.netsuite_id = l.transaction_id
    LEFT JOIN cost c ON c.transaction_id = l.transaction_id AND c.line_id = l.line_id
    JOIN kinds k ON k.tran_type = CASE WHEN c.line_id IS NULL THEN t.tran_type ELSE 'cost' END
    WHERE l.company_id = (SELECT id FROM company)
      AND l.posting_month = p_month
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
            -- An invoice's or credit memo's cost lines (invoice_cost) have the invoice's or credit memo's copy.
            SELECT i.doc_number AS number, i.party_name AS customer, i.voided, i.deleted_at, i.id
            FROM public.ledger_invoices i
            WHERE p.kind IN ('invoice', 'credit_memo', 'invoice_cost')
              AND i.source = 'netsuite' AND (i.doc_type = p.kind OR p.kind = 'invoice_cost') AND i.external_ref = p.doc
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
            UNION ALL
            -- One row at most, as the bills; the vendor named as gl_bill_payment_month names it.
            SELECT q.tranid, coalesce(w.name, q.vendor_name), q.voided, q.gone_at, NULL::uuid
            FROM public.gl_netsuite_bill_payments q
            LEFT JOIN public.gl_netsuite_lists w ON w.kind = 'vendor' AND w.netsuite_id = q.vendor_netsuite_id
            WHERE p.kind = 'bill_payment'
              AND q.netsuite_id = p.doc
            UNION ALL
            -- One row at most, as the bills; the payee named as gl_spending_month names it.
            SELECT s.tranid, coalesce(z.name, s.payee_name), s.voided, s.gone_at, NULL::uuid
            FROM public.gl_netsuite_spending s
            LEFT JOIN public.gl_netsuite_lists z ON z.kind = 'vendor' AND z.netsuite_id = s.payee_netsuite_id
            WHERE p.kind IN ('check', 'card_charge', 'card_refund')
              AND s.netsuite_id = p.doc
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
    'public.gl_stock_month(text, date)',
    'public.gl_stock_postings(text, text[], boolean)',
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

COMMENT ON FUNCTION public.gl_stock_month(text, date) IS 'Migration 395: one company''s NetSuite stock documents booked into one month (item fulfillments, item receipts, inventory adjustments and transfers, assembly builds and unbuilds, and the invoices and credit memos with cost lines), from the copy of NetSuite''s GL (migration 361), each with its type, its lines for the company (an invoice''s or credit memo''s cost lines only), their names and any FleetSuite customer, for the stock rule''s check and posting. Service role only.';
COMMENT ON FUNCTION public.gl_stock_postings(text, text[], boolean) IS 'Migration 395: what one company''s journal holds for its NetSuite stock documents (the entry that stands and its lines, every earlier entry and its reversal) and what the copy of NetSuite''s GL says of each now. Service role only.';
COMMENT ON FUNCTION public.gl_books_difference_documents(text, date, jsonb, integer) IS 'Migration 377, with 383''s deposits, 386''s bills, 390''s bill payments, 392''s checks and card charges and refunds and 395''s cost lines of invoices and credit memos (the kind ''cost''): one month''s documents of the kinds FleetSuite posts whose entries don''t come to what NetSuite posted for them, account by account, with what each side and the copy of NetSuite''s documents say of them. Service role only.';
COMMENT ON COLUMN gl_lines.vendor_ref IS 'The vendor a line is owed to or by: its NetSuite internal id, as netsuite_vendors.netsuite_id has it, kept without a foreign key. Set on the payables line of a vendor bill or bill credit (migration 386) and of a bill payment (migration 390), and on the payables lines of a NetSuite journal entry (migration 393), bank deposit or transfer (migration 394) or stock document (migration 395). NULL = no vendor.';
