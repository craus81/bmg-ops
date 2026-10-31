-- Migration 456: FleetSuite's own books, part 30 — FleetSuite's own
-- fulfillments, receipts and bills posted to the books.
--
-- Owner decision 2026-10-30 (thread "Replacing NetSuite with FleetSuite",
-- "Own postings", then "Build it"): the books post FleetSuite's own copy of
-- each fulfillment it makes (migration 416), each Receive on the Receiving
-- page (migration 435) and each bill it puts into NetSuite (migrations 435
-- and 436) the way they post its own invoices (migration 409): from the copy
-- when it matches NetSuite's document and its entry comes out the same,
-- account by account and on the same day, so nothing in the books moves when
-- a document changes copies; from NetSuite's otherwise, and the pages say
-- why. The posting job (src/lib/books/invoice-posting.ts,
-- src/lib/books/own-stock-posting.ts and own-bill-posting.ts) tells which an
-- entry was built from by its posting rule: own_fulfillment@1,
-- own_receipt@1 or own_bill@1 from FleetSuite's copy, stock@1 or bill@1 from
-- NetSuite's. Either way it's the document's entry, keyed as before
-- (`item_fulfillment:<NetSuite id>:<n>`, `item_receipt:…`, `vendor_bill:…`),
-- so nothing else that reads the books changes.
--
-- This changes two reads, with what they returned before unchanged, and adds
-- two:
--   * gl_stock_postings (migrations 395 and 397) and gl_bill_postings
--     (migration 386) say which rule made the entry that stands
--     (`posting_rule` on `current`), as gl_invoice_postings has since
--     migration 409;
--   * gl_stock_documents(company, ids), the stock documents named, as
--     gl_stock_month (migration 395) gives a month's, for the Own pages to
--     put one document's entry next to its copy's;
--   * gl_own_stock_accounts(company, fulfillments, receipts), the accounts
--     FleetSuite's own copies of those NetSuite fulfillments and item
--     receipts post to: each item's asset account from the copy of
--     NetSuite's items (migration 363), and, since NetSuite won't give an
--     item's cost of goods account (its cogsaccount), the account NetSuite's
--     last fulfillment of the item before each one debited its cost to, from
--     the copies of NetSuite's stock moves (migration 401) and general
--     ledger (migration 361), which share NetSuite's line ids; the account
--     most of the company's fulfillments debit their cost to, for an item
--     NetSuite hasn't fulfilled before; and the accounts the company's item
--     receipts credit, as gl_bill_month (migration 384) counts them for the
--     bill rule.
-- No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- pages' APIs.

-- What one company's journal holds for its NetSuite stock documents, as
-- migration 397 gives it, plus the rule that made the entry that stands:
-- stock@1 from the copy of NetSuite's GL, own_fulfillment@1 or own_receipt@1
-- from FleetSuite's own copy.
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
  -- The invoices and credit memos the copy still has a cost line of for the company, read once, and only when the journal
  -- holds a cost entry; each document is looked up in them.
  cost_documents AS MATERIALIZED (
    SELECT DISTINCT c.transaction_id
    FROM public.gl_netsuite_cost_lines(p_company, NULL) c
    WHERE EXISTS (SELECT 1 FROM docs d WHERE d.source_type = 'invoice_cost')
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
        'posting_rule', e.posting_rule,
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
        THEN cd.transaction_id IS NULL
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
  LEFT JOIN cost_documents cd ON d.source_type = 'invoice_cost' AND cd.transaction_id = d.source_id
$$;
-- What one company's journal holds for its NetSuite vendor bills and bill
-- credits, as migration 386 gives it, plus the rule that made the entry that
-- stands: bill@1 from NetSuite's bill, own_bill@1 from Books' own copy.
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
        'posting_rule', e.posting_rule,
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
-- One company's NetSuite stock documents p_ids (NetSuite's ids), as
-- gl_stock_month (migration 395) gives a month's: every item fulfillment,
-- item receipt, inventory adjustment or transfer, assembly build or unbuild
-- among them that the copy of NetSuite's GL has a line of for the company,
-- each with netsuite_id, type, number, date, posting_month, companies and
-- its lines for the company. An invoice's or credit memo's cost lines aren't
-- among them.
CREATE OR REPLACE FUNCTION public.gl_stock_documents(p_company TEXT, p_ids TEXT[])
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  documents AS (
    SELECT t.netsuite_id, t.tran_type, t.tranid, t.trandate, t.posting_month
    FROM public.gl_netsuite_transactions t
    WHERE t.netsuite_id = ANY (coalesce(p_ids, ARRAY[]::text[]))
      AND t.tran_type IN ('ItemShip', 'ItemRcpt', 'InvAdjst', 'InvTrnfr', 'Build', 'Unbuild')
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
  FROM documents m
$$;

-- The accounts FleetSuite's own copies of one company's NetSuite item
-- fulfillments p_fulfillments and item receipts p_receipts (NetSuite's ids)
-- post to:
--   items:        { <NetSuite item id>: its asset account (NetSuite's id), or null }, from the copy of NetSuite's
--                 items, for every item the copies name and NetSuite's receipts move;
--   fulfillments: { <NetSuite id>: { <item id>: {
--                   cost:     the account NetSuite's last fulfillment of the item for the company before this one (by
--                             date, then NetSuite's id) debited its cost to, outside the inventory accounts; null when
--                             NetSuite hasn't fulfilled it before,
--                   from:     { netsuite_id, number, date } that fulfillment,
--                   netsuite: the account this fulfillment debited the item's cost to, for saying why an entry
--                             differs } } };
--   usual_cost:   the account most of the company's fulfillments debit their cost to, for an item NetSuite hasn't
--                 fulfilled before; null when there are no fulfillments asked about or none debits one;
--   received:     [{ account, documents }] the accounts the company's item receipts credit, by how many receipts use
--                 each, as gl_bill_month gives them; empty when there are no receipts asked about.
-- An item's cost line is found by its line id: the copy of NetSuite's stock moves (migration 401) keeps every line that
-- names an item, NetSuite's cost of goods line among them, with the line id the copy of its general ledger keeps.
CREATE OR REPLACE FUNCTION public.gl_own_stock_accounts(p_company TEXT, p_fulfillments TEXT[], p_receipts TEXT[])
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  inventory AS (
    SELECT id FROM jsonb_array_elements_text(public.gl_stock_inventory_accounts()) AS a(id)
  ),
  own_fulfillments AS (
    SELECT o.netsuite_id, o.fulfil_date
    FROM public.gl_own_fulfillments o
    WHERE o.netsuite_id = ANY (coalesce(p_fulfillments, ARRAY[]::text[]))
      AND o.company_id = (SELECT id FROM company)
  ),
  fulfilled AS (
    SELECT DISTINCT o.netsuite_id, o.fulfil_date, l.item_netsuite_id AS item_id
    FROM own_fulfillments o
    JOIN public.gl_own_fulfillment_lines l ON l.fulfillment_id = o.netsuite_id
  ),
  learned AS (
    SELECT f.netsuite_id, f.item_id, c.account, c.document_id, c.number, c.date,
           (
             SELECT l.netsuite_account_id
             FROM public.gl_netsuite_stock_lines s
             JOIN public.gl_netsuite_lines l ON l.transaction_id = s.document_id AND l.line_id = s.line_id
             WHERE s.document_id = f.netsuite_id AND s.item_id = f.item_id
               AND s.company_id = (SELECT id FROM company) AND l.company_id = (SELECT id FROM company)
               AND l.debit > l.credit AND l.netsuite_account_id NOT IN (SELECT id FROM inventory)
             ORDER BY l.debit - l.credit DESC, l.netsuite_account_id::bigint
             LIMIT 1
           ) AS this_account
    FROM fulfilled f
    LEFT JOIN LATERAL (
      SELECT l.netsuite_account_id AS account, d.netsuite_id AS document_id, d.tranid AS number, d.trandate AS date
      FROM public.gl_netsuite_stock_lines s
      JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
      JOIN public.gl_netsuite_lines l ON l.transaction_id = s.document_id AND l.line_id = s.line_id
      WHERE s.item_id = f.item_id
        AND s.company_id = (SELECT id FROM company)
        AND l.company_id = (SELECT id FROM company)
        AND d.tran_type = 'ItemShip'
        AND d.gone_at IS NULL
        AND (d.trandate, d.netsuite_id::bigint) < (f.fulfil_date, f.netsuite_id::bigint)
        AND l.debit > l.credit
        AND l.netsuite_account_id NOT IN (SELECT id FROM inventory)
      ORDER BY d.trandate DESC, d.netsuite_id::bigint DESC, l.debit - l.credit DESC, l.netsuite_account_id::bigint
      LIMIT 1
    ) c ON true
  ),
  usual AS (
    SELECT l.netsuite_account_id AS account
    FROM public.gl_netsuite_transactions t
    JOIN public.gl_netsuite_lines l ON l.transaction_id = t.netsuite_id
    WHERE EXISTS (SELECT 1 FROM own_fulfillments)
      AND t.tran_type = 'ItemShip'
      AND l.company_id = (SELECT id FROM company)
      AND l.debit > l.credit
      AND l.netsuite_account_id NOT IN (SELECT id FROM inventory)
    GROUP BY l.netsuite_account_id
    ORDER BY count(DISTINCT l.transaction_id) DESC, l.netsuite_account_id::bigint
    LIMIT 1
  ),
  receipts AS (
    SELECT netsuite_id FROM unnest(coalesce(p_receipts, ARRAY[]::text[])) AS r(netsuite_id)
  ),
  items AS (
    SELECT item_id FROM fulfilled
    UNION
    SELECT l.item_netsuite_id
    FROM public.gl_own_receipts o
    JOIN public.gl_own_receipt_lines l ON l.receipt_key = o.receipt_key
    WHERE o.netsuite_id IN (SELECT netsuite_id FROM receipts) AND l.item_netsuite_id IS NOT NULL
    UNION
    SELECT s.item_id
    FROM public.gl_netsuite_stock_lines s
    WHERE s.document_id IN (SELECT netsuite_id FROM receipts)
  ),
  received AS (
    SELECT l.netsuite_account_id AS account, count(DISTINCT l.transaction_id) AS documents
    FROM public.gl_netsuite_transactions t
    JOIN public.gl_netsuite_lines l ON l.transaction_id = t.netsuite_id
    WHERE EXISTS (SELECT 1 FROM receipts)
      AND t.tran_type = 'ItemRcpt'
      AND l.company_id = (SELECT id FROM company)
      AND l.credit > l.debit
    GROUP BY l.netsuite_account_id
  )
  SELECT jsonb_build_object(
    'items', (
      SELECT coalesce(jsonb_object_agg(i.item_id, (
        SELECT CASE WHEN x.details->>'asset_account' ~ '^[0-9]+$' THEN x.details->>'asset_account' END
        FROM public.gl_netsuite_lists x
        WHERE x.kind = 'item' AND x.netsuite_id = i.item_id
      )), '{}'::jsonb)
      FROM items i
    ),
    'fulfillments', (
      SELECT coalesce(jsonb_object_agg(f.netsuite_id, f.items), '{}'::jsonb)
      FROM (
        SELECT l.netsuite_id, jsonb_object_agg(l.item_id, jsonb_build_object(
          'cost', l.account,
          'from', CASE WHEN l.document_id IS NOT NULL THEN jsonb_build_object(
            'netsuite_id', l.document_id, 'number', l.number, 'date', to_char(l.date, 'YYYY-MM-DD')
          ) END,
          'netsuite', l.this_account
        )) AS items
        FROM learned l
        GROUP BY l.netsuite_id
      ) f
    ),
    'usual_cost', (SELECT account FROM usual),
    'received', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('account', r.account, 'documents', r.documents)
                                ORDER BY r.documents DESC, r.account), '[]'::jsonb)
      FROM received r
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
    'public.gl_stock_postings(text, text[], boolean)',
    'public.gl_bill_postings(text, text[], boolean)',
    'public.gl_stock_documents(text, text[])',
    'public.gl_own_stock_accounts(text, text[], text[])'
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

COMMENT ON FUNCTION public.gl_stock_postings(text, text[], boolean) IS 'Migrations 395, 397 and 456: what one company''s journal holds for its NetSuite stock documents (the entry that stands, the rule that made it and its lines, every earlier entry and its reversal) and what the copy of NetSuite''s GL says of each now. Service role only.';
COMMENT ON FUNCTION public.gl_bill_postings(text, text[], boolean) IS 'Migrations 386 and 456: what one company''s journal holds for its NetSuite vendor bills and bill credits (the entry that stands, the rule that made it and its lines, every earlier entry and its reversal) and what the copy of NetSuite''s bills says of each now. Service role only.';
COMMENT ON FUNCTION public.gl_stock_documents(text, text[]) IS 'Migration 456: one company''s NetSuite stock documents named by id, each with its lines for the company from the copy of NetSuite''s GL, as gl_stock_month gives a month''s, for the Own pages. Service role only.';
COMMENT ON FUNCTION public.gl_own_stock_accounts(text, text[], text[]) IS 'Migration 456: the accounts FleetSuite''s own copies of some NetSuite fulfillments and item receipts post to: each item''s asset account, the cost account NetSuite''s last fulfillment of each item before each one used, the one most fulfillments use, and the accounts item receipts credit (src/lib/books/own-stock-posting.ts). Service role only.';
COMMENT ON TABLE gl_own_fulfillments IS 'Migration 416: FleetSuite''s own copy of each fulfillment it makes, worked out from its copy of the sales order (src/lib/books/own-fulfillments.ts), saved only by gl_own_fulfillment_save, by NetSuite''s id for the fulfillment. Since migration 456 the books post it in place of NetSuite''s fulfillment when it matches it (own_fulfillment@1, src/lib/books/own-stock-posting.ts). Service-role write and read.';
COMMENT ON TABLE gl_own_receipts IS 'Migration 435: Books'' own copy of each Receive on the Receiving page, saved only by gl_own_receipt_save, by FleetSuite''s first po_receipts row of it. Since migration 456 the books post it in place of NetSuite''s item receipt when it matches it (own_receipt@1, src/lib/books/own-stock-posting.ts). Service-role write and read.';
COMMENT ON TABLE gl_own_bills IS 'Migration 435: Books'' own copy of each bill FleetSuite makes in NetSuite, saved only by gl_own_bill_save, by NetSuite''s id for the bill. Since migration 456 the books post it in place of NetSuite''s bill when it matches it (own_bill@1, src/lib/books/own-bill-posting.ts). Service-role write and read.';
