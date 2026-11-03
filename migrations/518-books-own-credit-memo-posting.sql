-- Migration 518: FleetSuite's own books, a gap fixed: a credit memo
-- FleetSuite made posts from Books' own copy of it.
--
-- NetSuite Exit Checklist, "Gaps in what's built" (thread "Replacing NetSuite
-- with FleetSuite", 2026-11-03): credit memos, transfers, assembly builds and
-- counts' adjustments still post from NetSuite's documents. This is credit
-- memos' sale side. When FleetSuite makes a credit memo in NetSuite against
-- an invoice (Credit on the invoice, switched off until January 1, 2027) it
-- keeps its own copy (migration 466). Now each copy is put next to NetSuite's
-- credit memo as the ledger mirror copies it, and the books post it in place
-- of NetSuite's credit memo when it matches and its entry comes out the same,
-- account by account and on the same day, as an own invoice does (migration
-- 409; src/lib/books/own-credit-memo-check.ts and own-credit-memo-posting.ts,
-- rule own_credit_memo@1):
--   * gl_own_credit_memo_pairs(from, to, netsuite_id), the copies made on
--     those days, or the one, each with NetSuite's credit memo (ledger_invoices
--     'CustCred/<id>', migration 314), the location NetSuite booked it to (its
--     receivable line in the copy of NetSuite's general ledger, migration 361)
--     and the names the pages show;
--   * gl_own_credit_memo_months(), how many copies were made each month.
-- The stock a credit memo puts back on the shelf still posts from NetSuite's
-- credit memo, under Stock and cost. NetSuite books that stock's cost on
-- lines of their own, which the ledger mirror copies with the credit memo's
-- lines, as it does an invoice's that took its stock itself: each of
-- NetSuite's lines now says whether it is one (cost), as
-- gl_netsuite_cost_lines (migration 377) recognizes them by the accounts the
-- copy of NetSuite's general ledger has them on, so the checks compare only
-- what was sold or credited. gl_own_invoice_pairs (migration 407) gives the
-- same, so an own invoice that took its stock itself can match NetSuite's.
-- No table is added or changed.
--
-- Caller: the service role only, from the posting job, the daily check and
-- the Books pages' APIs.

-- ── Readers ────────────────────────────────────────────────────────────────

-- Books' own credit memos made from p_from to p_to, or only the one whose NetSuite id is p_netsuite_id, newest first,
-- each next to NetSuite's:
--   credit_memos: [{ own: the copy with its lines (amount: what the line credits, a discount the invoice gave, credited
--                         back, negative),
--                    netsuite: NetSuite's credit memo as the ledger mirror copied it, with its lines (netamount:
--                              NetSuite's own, signed, a credited sale positive; cost: the line books the cost of
--                              the stock that came back), or null before the mirror has it,
--                    netsuite_gl: { location_id } from its receivable line in the copy of NetSuite's general ledger,
--                                 or null before that copy has it,
--                    customer_name }]
--   items:     { <NetSuite item id>: { number, type } } for the items on either side's lines
--   tax_codes: { <NetSuite tax code id>: { name, rate } } for NetSuite's tax lines
--   locations: { <NetSuite location id>: name }
CREATE OR REPLACE FUNCTION public.gl_own_credit_memo_pairs(p_from DATE, p_to DATE, p_netsuite_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH own AS (
    SELECT o.*
    FROM public.gl_own_credit_memos o
    WHERE CASE WHEN p_netsuite_id IS NOT NULL THEN o.netsuite_id = p_netsuite_id
               ELSE o.credit_date BETWEEN p_from AND p_to END
  ), twin AS (
    SELECT o.netsuite_id AS own_id, c.*
    FROM own o
    JOIN public.ledger_invoices c ON c.source = 'netsuite' AND c.external_id = 'CustCred/' || o.netsuite_id
  ), cost_accounts AS (
    -- The accounts the cost of stock goes to, as gl_netsuite_cost_lines (migration 377) knows them.
    SELECT a.netsuite_account_id AS account_id FROM public.gl_accounts a
    WHERE a.account_type = 'cost_of_goods_sold' AND a.netsuite_account_id IS NOT NULL
    UNION
    SELECT it.details->>'asset_account' FROM public.gl_netsuite_lists it
    WHERE it.kind = 'item' AND it.details ? 'asset_account'
  )
  SELECT jsonb_build_object(
    'credit_memos', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'netsuite_id', o.netsuite_id,
          'number', o.netsuite_number,
          'invoice_id', o.invoice_netsuite_id,
          'invoice_number', o.invoice_number,
          'made_from_id', o.made_from_id,
          'customer_netsuite_id', o.customer_netsuite_id,
          'customer_id', o.customer_id,
          'date', to_char(o.credit_date, 'YYYY-MM-DD'),
          'location_id', o.location_netsuite_id,
          'reason', o.reason,
          'tax_rule', o.tax_rule,
          'tax_rate', o.tax_rate::text,
          'tax_rate_from', o.tax_rate_from,
          'subtotal', o.subtotal::text,
          'tax', o.tax::text,
          'total', o.total::text,
          'made_at', o.made_at,
          'lines', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'line_no', l.line_no,
              'invoice_line', l.invoice_line,
              'item_id', l.item_netsuite_id,
              'item_number', l.item_number,
              'description', l.description,
              'quantity', l.quantity::text,
              'rate', l.rate::text,
              'amount', l.amount::text,
              'taxable', l.taxable,
              'tax', l.tax::text,
              'back_to_stock', l.back_to_stock,
              'on_credit_item', l.on_credit_item
            ) ORDER BY l.line_no), '[]'::jsonb)
            FROM public.gl_own_credit_memo_lines l
            WHERE l.credit_memo_id = o.netsuite_id
          )
        ),
        'netsuite', (
          SELECT jsonb_build_object(
            'number', t.doc_number,
            'date', to_char(t.doc_date, 'YYYY-MM-DD'),
            'total', t.total::text,
            'customer_netsuite_id', t.customer_netsuite_id,
            'customer_name', t.party_name,
            'memo', t.memo,
            'status', t.status_label,
            'voided', t.voided,
            'deleted', t.deleted_at IS NOT NULL,
            'lines_copied', t.lines_synced_at IS NOT NULL,
            'changed_at', t.source_updated_at,
            'copied_at', t.last_synced_at,
            'lines', (
              SELECT coalesce(jsonb_agg(jsonb_build_object(
                'line_id', cl.line_external_id,
                'line_no', cl.line_no,
                'kind', cl.line_kind,
                'item_id', cl.item_external_id,
                'item_number', cl.item_number,
                'description', cl.description,
                'quantity', cl.quantity::text,
                'rate', cl.unit_price::text,
                'amount', cl.amount::text,
                'netamount', cl.raw->>'netamount',
                -- On a cost account in the copy of NetSuite's general ledger, and not on its own item's income account.
                'cost', EXISTS (
                  SELECT 1 FROM public.gl_netsuite_lines g
                  JOIN cost_accounts ca ON ca.account_id = g.netsuite_account_id
                  WHERE g.transaction_id = t.own_id AND g.line_id = cl.line_external_id
                    AND NOT EXISTS (
                      SELECT 1 FROM public.gl_netsuite_lists it
                      WHERE it.kind = 'item' AND it.netsuite_id = cl.item_external_id
                        AND it.details->>'income_account' = g.netsuite_account_id
                    )
                )
              ) ORDER BY cl.line_no NULLS LAST, cl.line_external_id), '[]'::jsonb)
              FROM public.ledger_invoice_lines cl
              WHERE cl.document_id = t.id
            )
          )
          FROM twin t
          WHERE t.own_id = o.netsuite_id
        ),
        'netsuite_gl', (
          SELECT jsonb_build_object('location_id', g.location_id)
          FROM public.gl_netsuite_lines g WHERE g.transaction_id = o.netsuite_id AND g.line_id = '0'
        ),
        'customer_name', coalesce(
          (SELECT nullif(btrim(c.company_name), '') FROM public.customers c WHERE c.id = o.customer_id),
          (SELECT lc.display_name FROM public.ledger_customers lc
           WHERE lc.source = 'netsuite' AND lc.external_id = 'customer/' || o.customer_netsuite_id),
          (SELECT cl.name FROM public.gl_netsuite_lists cl WHERE cl.kind = 'customer' AND cl.netsuite_id = o.customer_netsuite_id)
        )
      ) ORDER BY o.credit_date DESC, o.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM own o
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object('number', l.name, 'type', l.details->>'item_type')), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'item' AND l.netsuite_id IN (
        SELECT ol.item_netsuite_id FROM public.gl_own_credit_memo_lines ol JOIN own o ON o.netsuite_id = ol.credit_memo_id
        UNION
        SELECT cl.item_external_id FROM public.ledger_invoice_lines cl JOIN twin t ON t.id = cl.document_id
        WHERE cl.line_kind <> 'tax'
      )
    ),
    'tax_codes', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object('name', l.name, 'rate', l.details->>'rate')), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'tax_code' AND l.netsuite_id IN (
        SELECT cl.item_external_id FROM public.ledger_invoice_lines cl JOIN twin t ON t.id = cl.document_id
        WHERE cl.line_kind = 'tax'
      )
    ),
    'locations', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, l.name), '{}'::jsonb)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'location'
    )
  )
$$;

-- How many own credit memos FleetSuite made each month, newest first: [{ month: 'YYYY-MM-01', credit_memos }].
CREATE OR REPLACE FUNCTION public.gl_own_credit_memo_months()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM-DD'), 'credit_memos', m.credit_memos)
                            ORDER BY m.month DESC), '[]'::jsonb)
  FROM (
    SELECT date_trunc('month', credit_date)::date AS month, count(*) AS credit_memos
    FROM public.gl_own_credit_memos
    GROUP BY 1
  ) m
$$;

-- FleetSuite's own invoices, as migration 407 reads them, and each of NetSuite's lines now also says whether it books
-- the cost of the stock the invoice took itself (cost), as the credit memos' read above does.
CREATE OR REPLACE FUNCTION public.gl_own_invoice_pairs(p_from DATE, p_to DATE, p_netsuite_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH own AS (
    SELECT o.*
    FROM public.gl_own_invoices o
    WHERE CASE WHEN p_netsuite_id IS NOT NULL THEN o.netsuite_id = p_netsuite_id
               ELSE o.invoice_date BETWEEN p_from AND p_to END
  ), twin AS (
    SELECT o.netsuite_id AS own_id, i.*
    FROM own o
    JOIN public.ledger_invoices i ON i.source = 'netsuite' AND i.external_id = 'CustInvc/' || o.netsuite_id
  ), cost_accounts AS (
    -- The accounts the cost of stock goes to, as gl_netsuite_cost_lines (migration 377) knows them.
    SELECT a.netsuite_account_id AS account_id FROM public.gl_accounts a
    WHERE a.account_type = 'cost_of_goods_sold' AND a.netsuite_account_id IS NOT NULL
    UNION
    SELECT it.details->>'asset_account' FROM public.gl_netsuite_lists it
    WHERE it.kind = 'item' AND it.details ? 'asset_account'
  )
  SELECT jsonb_build_object(
    'invoices', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'netsuite_id', o.netsuite_id,
          'number', o.netsuite_number,
          'made_from', o.made_from,
          'made_from_id', o.made_from_id,
          'sales_order_id', o.sales_order_id,
          'customer_netsuite_id', o.customer_netsuite_id,
          'customer_id', o.customer_id,
          'date', to_char(o.invoice_date, 'YYYY-MM-DD'),
          'location_id', o.location_netsuite_id,
          'location_from', o.location_from,
          'po_number', o.po_number,
          'memo', o.memo,
          'vin', o.vin,
          'terms_id', o.terms_netsuite_id,
          'terms_name', o.terms_name,
          'terms_days', o.terms_days,
          'due_date', to_char(o.due_date, 'YYYY-MM-DD'),
          'tax_rule', o.tax_rule,
          'tax_basis', o.tax_basis,
          'tax_rate', o.tax_rate::text,
          'subtotal', o.subtotal::text,
          'tax', o.tax::text,
          'total', o.total::text,
          'lines_from', o.lines_from,
          'unknowns', to_jsonb(o.unknowns),
          'made_at', o.made_at,
          'lines', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'line_no', l.line_no,
              'item_id', l.item_netsuite_id,
              'item_number', l.item_number,
              'description', l.description,
              'quantity', l.quantity::text,
              'rate', l.rate::text,
              'amount', l.amount::text,
              'priced', l.priced,
              'taxable', l.taxable,
              'tax', l.tax::text,
              'sales_order_line_id', l.sales_order_line_id
            ) ORDER BY l.line_no), '[]'::jsonb)
            FROM public.gl_own_invoice_lines l
            WHERE l.invoice_id = o.netsuite_id
          )
        ),
        'netsuite', (
          SELECT jsonb_build_object(
            'number', t.doc_number,
            'date', to_char(t.doc_date, 'YYYY-MM-DD'),
            'due_date', to_char(t.due_date, 'YYYY-MM-DD'),
            'total', t.total::text,
            'customer_netsuite_id', t.customer_netsuite_id,
            'customer_name', t.party_name,
            'po_number', t.po_number,
            'memo', t.memo,
            'status', t.status_label,
            'voided', t.voided,
            'deleted', t.deleted_at IS NOT NULL,
            'lines_copied', t.lines_synced_at IS NOT NULL,
            'changed_at', t.source_updated_at,
            'copied_at', t.last_synced_at,
            'lines', (
              SELECT coalesce(jsonb_agg(jsonb_build_object(
                'line_id', il.line_external_id,
                'line_no', il.line_no,
                'kind', il.line_kind,
                'item_id', il.item_external_id,
                'item_number', il.item_number,
                'description', il.description,
                'quantity', il.quantity::text,
                'rate', il.unit_price::text,
                'amount', il.amount::text,
                'netamount', il.raw->>'netamount',
                -- On a cost account in the copy of NetSuite's general ledger, and not on its own item's income account.
                'cost', EXISTS (
                  SELECT 1 FROM public.gl_netsuite_lines g
                  JOIN cost_accounts ca ON ca.account_id = g.netsuite_account_id
                  WHERE g.transaction_id = t.own_id AND g.line_id = il.line_external_id
                    AND NOT EXISTS (
                      SELECT 1 FROM public.gl_netsuite_lists it
                      WHERE it.kind = 'item' AND it.netsuite_id = il.item_external_id
                        AND it.details->>'income_account' = g.netsuite_account_id
                    )
                )
              ) ORDER BY il.line_no NULLS LAST, il.line_external_id), '[]'::jsonb)
              FROM public.ledger_invoice_lines il
              WHERE il.document_id = t.id
            )
          )
          FROM twin t
          WHERE t.own_id = o.netsuite_id
        ),
        'netsuite_gl', (
          SELECT jsonb_build_object('location_id', g.location_id)
          FROM public.gl_netsuite_lines g WHERE g.transaction_id = o.netsuite_id AND g.line_id = '0'
        ),
        'customer_name', coalesce(
          (SELECT nullif(btrim(c.company_name), '') FROM public.customers c WHERE c.id = o.customer_id),
          (SELECT lc.display_name FROM public.ledger_customers lc
           WHERE lc.source = 'netsuite' AND lc.external_id = 'customer/' || o.customer_netsuite_id),
          (SELECT cl.name FROM public.gl_netsuite_lists cl WHERE cl.kind = 'customer' AND cl.netsuite_id = o.customer_netsuite_id)
        ),
        'customer_list', (
          SELECT cl.details FROM public.gl_netsuite_lists cl WHERE cl.kind = 'customer' AND cl.netsuite_id = o.customer_netsuite_id
        )
      ) ORDER BY o.invoice_date DESC, o.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM own o
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object('number', l.name, 'type', l.details->>'item_type')), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'item' AND l.netsuite_id IN (
        SELECT ol.item_netsuite_id FROM public.gl_own_invoice_lines ol JOIN own o ON o.netsuite_id = ol.invoice_id
        UNION
        SELECT il.item_external_id FROM public.ledger_invoice_lines il JOIN twin t ON t.id = il.document_id
        WHERE il.line_kind <> 'tax'
      )
    ),
    'tax_codes', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object('name', l.name, 'rate', l.details->>'rate')), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'tax_code' AND l.netsuite_id IN (
        SELECT il.item_external_id FROM public.ledger_invoice_lines il JOIN twin t ON t.id = il.document_id
        WHERE il.line_kind = 'tax'
      )
    ),
    'locations', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, l.name), '{}'::jsonb)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'location'
    ),
    'terms', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object(
        'name', l.name, 'days', (l.details->>'days_until_net_due')::numeric
      )), '{}'::jsonb)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'term'
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
    'public.gl_own_credit_memo_pairs(date, date, text)',
    'public.gl_own_credit_memo_months()'
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

COMMENT ON TABLE gl_own_credit_memos IS 'Migration 466: Books'' own copy of each credit memo FleetSuite makes in NetSuite against an invoice, worked out by its own rules (src/lib/books/own-credit-memos.ts), saved only by gl_own_credit_memo_save, by NetSuite''s id for the credit memo. Since migration 518 it is checked against NetSuite''s credit memo (src/lib/books/own-credit-memo-check.ts), and the books post it in place of NetSuite''s when it matches (own_credit_memo@1, src/lib/books/own-credit-memo-posting.ts). Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_credit_memo_pairs(date, date, text) IS 'Migration 518: Books'' own credit memos made on some days, or one, each next to NetSuite''s credit memo as the ledger mirror copied it, with the location NetSuite booked it to and the names the pages show, for the posting job, the daily check and the Own credit memos page. Service role only.';
COMMENT ON FUNCTION public.gl_own_invoice_pairs(date, date, text) IS 'Migration 407: FleetSuite''s own invoices made on some days, or one, each next to NetSuite''s invoice as the ledger mirror copied it, with the names the pages show, for FleetSuite''s own invoices and the daily check. Since migration 518 each of NetSuite''s lines says whether it books the cost of the stock the invoice took itself. Service role only.';
COMMENT ON FUNCTION public.gl_own_credit_memo_months() IS 'Migration 518: how many own credit memos FleetSuite made each month. Service role only.';
