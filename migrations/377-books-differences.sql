-- Migration 377: FleetSuite's own books, part 9 — what still differs from
-- NetSuite, and why.
--
-- Owner decision 2026-10-15 (thread "Replacing NetSuite with FleetSuite"): a
-- page puts FleetSuite's own journal next to the copy of NetSuite's general
-- ledger (migration 361), account by account and month by month, and shows
-- what still differs and why: the kinds of NetSuite documents FleetSuite
-- doesn't post yet, and, for the ones it does, each document whose entry
-- differs from what NetSuite posted for it.
--
-- Reads only; no table is added or changed:
--   * gl_netsuite_cost_lines: the lines of NetSuite's invoices and credit
--     memos that book the cost of the stock rather than the sale, which
--     FleetSuite posts with fulfillments instead;
--   * gl_books_differences: each side's movement per month, account and kind
--     of document, and how many documents of each kind moved how much;
--   * gl_books_difference_documents: for one month, the documents FleetSuite
--     posts whose entries don't come to what NetSuite posted for them.
-- NetSuite's side is grouped by the month NetSuite posted to (its accounting
-- period), as the trial balance check groups it; FleetSuite's by the date of
-- each entry. A reversal is counted with the document it reverses: the
-- posting job dates it as that document's entry, so a document whose entry
-- was replaced comes to its new entry within the month.
--
-- Caller: the service role only, from the super admin page's API.

-- One company's lines on NetSuite invoices and credit memos (p_month NULL:
-- every month) that book the cost of the stock sold or returned: those to a
-- cost of goods sold account or to an item's inventory asset account, unless
-- the account is the income account of the line's own item. That is how the
-- invoice check recognizes them by their accounts (costLines in
-- src/lib/books/invoice-check.ts). NetSuite's own cost of goods flag isn't
-- copied, so a line it flags that went to another kind of account isn't one
-- of these.
CREATE OR REPLACE FUNCTION public.gl_netsuite_cost_lines(p_company TEXT, p_month DATE)
RETURNS TABLE (transaction_id TEXT, line_id TEXT)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT l.transaction_id, l.line_id
  FROM public.gl_netsuite_lines l
  JOIN public.gl_companies c ON c.id = l.company_id
  JOIN public.gl_netsuite_transactions t ON t.netsuite_id = l.transaction_id
  WHERE c.code = p_company
    AND t.tran_type IN ('CustInvc', 'CustCred')
    AND (p_month IS NULL OR l.posting_month = p_month)
    AND (
      l.netsuite_account_id IN (
        SELECT a.netsuite_account_id FROM public.gl_accounts a
        WHERE a.account_type = 'cost_of_goods_sold' AND a.netsuite_account_id IS NOT NULL
      )
      OR l.netsuite_account_id IN (
        SELECT it.details->>'asset_account' FROM public.gl_netsuite_lists it
        WHERE it.kind = 'item' AND it.details ? 'asset_account'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.ledger_invoices d
      JOIN public.ledger_invoice_lines dl ON dl.document_id = d.id
      JOIN public.gl_netsuite_lists it ON it.kind = 'item' AND it.netsuite_id = dl.item_external_id
      WHERE d.source = 'netsuite'
        AND d.external_ref = l.transaction_id
        AND dl.line_external_id = l.line_id
        AND it.details->>'income_account' = l.netsuite_account_id
    )
$$;

-- Both sides of one company's books, month by month:
--   netsuite / fleetsuite: the movement (debits less credits) per month,
--     account and kind of document, where it isn't zero. NetSuite's kind is
--     its transaction type, or 'cost' for gl_netsuite_cost_lines; FleetSuite's
--     is the source type of the entry, or of the entry a reversal reverses.
--     A FleetSuite account the chart has no NetSuite account for is named
--     'fs:<its id>'.
--   netsuite_kinds / fleetsuite_kinds: per month and kind, how many
--     documents moved anything and how much they moved: each document's
--     movement on each account, the debits added up.
--   cost_accounts: the accounts gl_netsuite_cost_lines looks for.
-- Amounts are text, so no float ever rounds a cent.
CREATE OR REPLACE FUNCTION public.gl_books_differences(p_company TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  cost AS (
    SELECT transaction_id, line_id FROM public.gl_netsuite_cost_lines(p_company, NULL)
  ),
  ns AS (
    SELECT l.posting_month AS month,
           l.netsuite_account_id AS account,
           CASE WHEN c.line_id IS NULL THEN t.tran_type ELSE 'cost' END AS kind,
           l.transaction_id AS doc,
           sum(l.debit) - sum(l.credit) AS net
    FROM public.gl_netsuite_lines l
    JOIN public.gl_netsuite_transactions t ON t.netsuite_id = l.transaction_id
    LEFT JOIN cost c ON c.transaction_id = l.transaction_id AND c.line_id = l.line_id
    WHERE l.company_id = (SELECT id FROM company)
    GROUP BY 1, 2, 3, 4
  ),
  fs AS (
    SELECT date_trunc('month', l.entry_date)::date AS month,
           coalesce(a.netsuite_account_id, 'fs:' || a.id::text) AS account,
           coalesce(o.source_type, e.source_type) AS kind,
           coalesce(o.source_id, o.id::text, e.source_id, e.id::text) AS doc,
           sum(l.debit) - sum(l.credit) AS net
    FROM public.gl_lines l
    JOIN public.gl_entries e ON e.id = l.entry_id
    LEFT JOIN public.gl_entries o ON o.id = e.reverses_entry_id
    JOIN public.gl_accounts a ON a.id = l.account_id
    WHERE l.company_id = (SELECT id FROM company)
    GROUP BY 1, 2, 3, 4
  )
  SELECT jsonb_build_object(
    'netsuite', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'month', to_char(x.month, 'YYYY-MM-DD'), 'account', x.account, 'kind', x.kind, 'net', x.net::text
      ) ORDER BY x.month, x.account, x.kind), '[]'::jsonb)
      FROM (SELECT month, account, kind, sum(net) AS net FROM ns GROUP BY 1, 2, 3 HAVING sum(net) <> 0) x
    ),
    'fleetsuite', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'month', to_char(x.month, 'YYYY-MM-DD'), 'account', x.account, 'kind', x.kind, 'net', x.net::text
      ) ORDER BY x.month, x.account, x.kind), '[]'::jsonb)
      FROM (SELECT month, account, kind, sum(net) AS net FROM fs GROUP BY 1, 2, 3 HAVING sum(net) <> 0) x
    ),
    'netsuite_kinds', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'month', to_char(x.month, 'YYYY-MM-DD'), 'kind', x.kind, 'documents', x.documents, 'moved', x.moved::text
      ) ORDER BY x.month, x.kind), '[]'::jsonb)
      FROM (
        SELECT month, kind, count(DISTINCT doc) FILTER (WHERE net <> 0) AS documents, sum(greatest(net, 0)) AS moved
        FROM ns GROUP BY 1, 2
      ) x
      WHERE x.documents > 0
    ),
    'fleetsuite_kinds', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'month', to_char(x.month, 'YYYY-MM-DD'), 'kind', x.kind, 'documents', x.documents, 'moved', x.moved::text
      ) ORDER BY x.month, x.kind), '[]'::jsonb)
      FROM (
        SELECT month, kind, count(DISTINCT doc) FILTER (WHERE net <> 0) AS documents, sum(greatest(net, 0)) AS moved
        FROM fs GROUP BY 1, 2
      ) x
      WHERE x.documents > 0
    ),
    'cost_accounts', (
      SELECT coalesce(jsonb_agg(x.account ORDER BY x.account), '[]'::jsonb)
      FROM (
        SELECT a.netsuite_account_id AS account FROM public.gl_accounts a
        WHERE a.account_type = 'cost_of_goods_sold' AND a.netsuite_account_id IS NOT NULL
        UNION
        SELECT it.details->>'asset_account' FROM public.gl_netsuite_lists it
        WHERE it.kind = 'item' AND it.details ? 'asset_account'
      ) x
    )
  )
$$;

-- One month's documents whose FleetSuite entries don't come to what NetSuite
-- posted for them, account by account, for the kinds FleetSuite posts.
-- p_kinds maps each of FleetSuite's source types to NetSuite's transaction
-- type, e.g. {"invoice": "CustInvc", "credit_memo": "CustCred",
-- "payment": "CustPymt"}; a document is the same on both sides when
-- FleetSuite's source_id is NetSuite's internal id. NetSuite's cost lines
-- (gl_netsuite_cost_lines) are left out: FleetSuite posts that cost with
-- fulfillments. Returns the number that differ per kind (`counts`) and, the
-- largest differences first, at most p_limit of them (1 to 1000) with:
--   lines: each account either side moved this month, both amounts;
--   netsuite: the copy's type, number, date and the month NetSuite posted it
--     to (null when this company has no line of it in the copy);
--   fleetsuite: how many entries it has had, and the one that stands;
--   copy: what the copy of NetSuite's invoices, credit memos or payments
--     (migration 314) says of it: number, customer, voided, deleted.
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
    'public.gl_netsuite_cost_lines(text, date)',
    'public.gl_books_differences(text)',
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

COMMENT ON FUNCTION public.gl_netsuite_cost_lines(text, date) IS 'Migration 377: one company''s lines on NetSuite invoices and credit memos that book the cost of the stock (to a cost of goods sold account or an item''s inventory asset account, not the line item''s income account), which FleetSuite posts with fulfillments. Service role only.';
COMMENT ON FUNCTION public.gl_books_differences(text) IS 'Migration 377: one company''s journal and its copy of NetSuite''s general ledger side by side: each side''s movement per month, account and kind of document, and per month and kind how many documents moved how much. Service role only.';
COMMENT ON FUNCTION public.gl_books_difference_documents(text, date, jsonb, integer) IS 'Migration 377: one month''s documents of the kinds FleetSuite posts whose entries don''t come to what NetSuite posted for them, account by account, with what each side and the copy of NetSuite''s documents say of them. Service role only.';
