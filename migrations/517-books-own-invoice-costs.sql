-- Migration 517: FleetSuite's own books, a gap fixed: an invoice's cost
-- posts from FleetSuite's own copy of the invoice.
--
-- NetSuite Exit Checklist, "Gaps in what's built" (thread "Replacing NetSuite
-- with FleetSuite", 2026-11-03): credit memos, transfers, assembly builds,
-- counts' adjustments and invoices' cost lines still post from NetSuite's
-- documents. This is the first of them, invoices' cost lines. An invoice
-- FleetSuite makes without a sales order (from the Scan Log, a PO's open
-- quantities, a graphics job, or typed in FleetSuite) takes its stock
-- itself: NetSuite takes each item it bills that it keeps in stock from the
-- invoice's location and books its cost on the invoice, which the books post
-- apart from the sale (`invoice_cost:<NetSuite id>`, the stock rule). Now
-- that cost posts from FleetSuite's own copy of the invoice (migration 407)
-- when what the copy took matches NetSuite's invoice and its entry comes out
-- the same, account by account and on the same day, as a fulfillment's does
-- (migration 456; src/lib/books/own-invoice-cost-check.ts and
-- own-stock-posting.ts):
--   * gl_own_invoice_cost_pairs(from, to, id?): FleetSuite's own invoices
--     made without a sales order, each next to NetSuite's invoice as the copy
--     of its stock moves has it (migration 401), with its cost lines in the
--     copy of its general ledger (gl_netsuite_cost_lines, migration 377) and
--     what FleetSuite counted of each item at the invoice's location just
--     before, as gl_own_fulfillment_pairs gives a fulfillment's (migration
--     514); with each kit's parts from the copy of NetSuite's items
--     (details.parts), since NetSuite takes a kit's parts from stock;
--   * gl_own_invoice_cost_accounts(company, items): the accounts those
--     copies' entries post to: each item's asset account, and the cost
--     account NetSuite's last fulfillment or invoice of the item before each
--     invoice debited, or for an item NetSuite hasn't shipped or sold before,
--     the one most fulfillments debit;
--   * gl_stock_documents(company, ids) also gives the invoices and credit
--     memos named that have cost lines, with those lines alone, as
--     gl_stock_month does (migration 395), for the Own invoices page to put
--     an invoice's cost entry next to its copy's.
-- No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- pages' APIs.

-- ── Readers ────────────────────────────────────────────────────────────────

-- FleetSuite's own invoices made without a sales order from p_from to p_to, or only the one whose NetSuite id is
-- p_netsuite_id, newest first, each next to NetSuite's invoice:
--   invoices: [{ own: the copy, with the lines that bill an item NetSuite may keep in stock (one the copy of NetSuite's
--                     items keeps in stock, a kit, or one it doesn't have or doesn't type) and its type there
--                     (item_type, null when not known); made_at, and fixed_at when FleetSuite fixed it since
--                     (migration 471),
--                netsuite: NetSuite's invoice as the copy of its stock moves has it, with each line that names an item:
--                          its location, quantity (signed, stock out negative), whether it moves stock, and its value,
--                          what NetSuite posted to an inventory account on it (debit positive; null when the copy of
--                          its general ledger has nothing on the line); null when the stock copy doesn't have it,
--                netsuite_gl: { posting_month, entry: what its cost lines posted to each account } once the copy of
--                             NetSuite's general ledger has the invoice, else null,
--                before: [{ item_id, location_id, quantity, value }] what FleetSuite counted of each item at each
--                        location either side names just before the invoice (the copy's items and their kits' parts
--                        at its location, NetSuite's where it moved stock), as gl_own_fulfillment_pairs counts them,
--                customer_name }]
--   items:     { <NetSuite item id>: { number, type, display_name, parts } } for the items on either side and every
--              part of a kit among them, kits inside kits too (parts: a kit's, as the copy keeps them; else null)
--   locations: { <NetSuite location id>: name }
--   accounts:  { <NetSuite account id>: { number, name } } for the accounts NetSuite's invoices posted to
-- Quantities and amounts are decimal strings.
CREATE OR REPLACE FUNCTION public.gl_own_invoice_cost_pairs(p_from DATE, p_to DATE, p_netsuite_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH RECURSIVE own AS (
    -- An invoice off a sales order takes nothing from stock: the order's fulfillment did.
    SELECT o.*
    FROM public.gl_own_invoices o
    WHERE o.sales_order_id IS NULL
      AND CASE WHEN p_netsuite_id IS NOT NULL THEN o.netsuite_id = p_netsuite_id
               ELSE o.invoice_date BETWEEN p_from AND p_to END
  ),
  own_lines AS (
    -- The lines that bill an item NetSuite may keep in stock: one the copy of its items keeps in stock, a kit, or one it
    -- doesn't have, or has with no type, which may be.
    SELECT l.invoice_id, l.line_no, l.item_netsuite_id AS item_id, l.item_number, l.description, l.quantity,
           nullif(it.details->>'item_type', '') AS item_type
    FROM public.gl_own_invoice_lines l
    JOIN own o ON o.netsuite_id = l.invoice_id
    LEFT JOIN public.gl_netsuite_lists it ON it.kind = 'item' AND it.netsuite_id = l.item_netsuite_id
    WHERE l.item_netsuite_id ~ '^[0-9]+$'
      AND l.quantity IS NOT NULL AND l.quantity <> 0
      AND coalesce(it.details->>'item_type', '') IN ('', 'InvtPart', 'Assembly', 'Kit')
  ),
  kit_reach AS (
    -- Every item inside a kit the lines bill, a kit inside a kit's too, as deep as the check takes kits apart.
    SELECT ol.invoice_id, p.part->>'item' AS item_id, 1 AS depth
    FROM own_lines ol
    JOIN public.gl_netsuite_lists k ON k.kind = 'item' AND k.netsuite_id = ol.item_id AND k.details->>'item_type' = 'Kit'
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(k.details->'parts') = 'array' THEN k.details->'parts' ELSE '[]'::jsonb END
    ) AS p(part)
    WHERE p.part->>'item' ~ '^[0-9]+$'
    UNION
    SELECT r.invoice_id, p.part->>'item', r.depth + 1
    FROM kit_reach r
    JOIN public.gl_netsuite_lists k ON k.kind = 'item' AND k.netsuite_id = r.item_id AND k.details->>'item_type' = 'Kit'
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(k.details->'parts') = 'array' THEN k.details->'parts' ELSE '[]'::jsonb END
    ) AS p(part)
    WHERE r.depth < 6 AND p.part->>'item' ~ '^[0-9]+$'
  ),
  billed AS (
    SELECT invoice_id, item_id FROM own_lines
    UNION
    SELECT invoice_id, item_id FROM kit_reach
  ),
  stocked AS (
    -- The items NetSuite keeps in stock (bill-rule.ts STOCK_TYPES); only they have a value, as in gl_stock_items.
    SELECT i.netsuite_id AS item_id
    FROM public.gl_netsuite_lists i
    WHERE i.kind = 'item' AND i.details->>'item_type' IN ('InvtPart', 'Assembly')
  ),
  asset_accounts AS (
    SELECT id FROM jsonb_array_elements_text(public.gl_stock_inventory_accounts()) AS a(id)
  ),
  twin AS (
    SELECT o.netsuite_id AS own_id, d.*
    FROM own o
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = o.netsuite_id
  ),
  twin_lines AS (
    SELECT t.own_id, s.line_id, s.company_id, s.item_id, s.location_id, s.quantity, s.moves_stock,
           (SELECT sum(l.debit - l.credit)
            FROM public.gl_netsuite_lines l
            WHERE l.transaction_id = s.document_id AND l.line_id = s.line_id
              AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)) AS value
    FROM twin t
    JOIN public.gl_netsuite_stock_lines s ON s.document_id = t.netsuite_id
  ),
  places AS (
    -- Each item at each location either side names: the copy's items and their kits' parts at the invoice's location,
    -- NetSuite's where it moved stock.
    SELECT o.netsuite_id AS own_id, o.company_id, o.invoice_date, b.item_id, o.location_netsuite_id AS location_id
    FROM own o
    JOIN billed b ON b.invoice_id = o.netsuite_id
    WHERE o.location_netsuite_id IS NOT NULL
    UNION
    SELECT o.netsuite_id, o.company_id, o.invoice_date, tl.item_id, tl.location_id
    FROM own o
    JOIN twin_lines tl ON tl.own_id = o.netsuite_id AND tl.company_id = o.company_id
    WHERE tl.moves_stock
  ),
  before AS (
    SELECT p.own_id, p.item_id, p.location_id,
           coalesce(op.quantity, 0) + coalesce(mv.quantity, 0) AS quantity,
           CASE WHEN p.item_id IN (SELECT item_id FROM stocked) THEN coalesce(op.value, 0) + coalesce(vl.value, 0) ELSE 0 END AS value
    FROM places p
    LEFT JOIN public.gl_netsuite_stock_opening op
      ON op.company_id = p.company_id AND op.item_id = p.item_id AND op.location_id IS NOT DISTINCT FROM p.location_id
    LEFT JOIN LATERAL (
      SELECT sum(s.quantity) AS quantity
      FROM public.gl_netsuite_stock_lines s
      JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
      WHERE s.item_id = p.item_id AND s.company_id = p.company_id AND s.location_id IS NOT DISTINCT FROM p.location_id
        AND s.moves_stock AND d.gone_at IS NULL
        AND (d.trandate, d.netsuite_id::bigint) < (p.invoice_date, p.own_id::bigint)
    ) mv ON true
    LEFT JOIN LATERAL (
      SELECT sum(l.debit - l.credit) AS value
      FROM public.gl_netsuite_stock_lines s
      JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
      JOIN public.gl_netsuite_lines l ON l.transaction_id = s.document_id AND l.line_id = s.line_id
      WHERE s.item_id = p.item_id AND s.company_id = p.company_id AND s.location_id IS NOT DISTINCT FROM p.location_id
        AND d.gone_at IS NULL
        AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)
        AND (d.trandate, d.netsuite_id::bigint) < (p.invoice_date, p.own_id::bigint)
    ) vl ON true
  ),
  booked AS (
    -- The month the copy of NetSuite's general ledger has each invoice booked into, and the company it's FleetSuite's for.
    SELECT o.netsuite_id AS own_id, c.code AS company, g.posting_month
    FROM own o
    JOIN public.gl_netsuite_transactions g ON g.netsuite_id = o.netsuite_id
    JOIN public.gl_companies c ON c.id = o.company_id
  ),
  cost AS MATERIALIZED (
    -- The invoices' cost lines, as the stock rule posts them (gl_netsuite_cost_lines), read once for each month.
    SELECT cl.transaction_id, cl.line_id
    FROM (SELECT DISTINCT company, posting_month FROM booked) m
    CROSS JOIN LATERAL public.gl_netsuite_cost_lines(m.company, m.posting_month) cl
    WHERE cl.transaction_id IN (SELECT own_id FROM booked)
  )
  SELECT jsonb_build_object(
    'invoices', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'netsuite_id', o.netsuite_id,
          'number', o.netsuite_number,
          'made_from', o.made_from,
          'made_from_id', o.made_from_id,
          'customer_netsuite_id', o.customer_netsuite_id,
          'date', to_char(o.invoice_date, 'YYYY-MM-DD'),
          'location_id', o.location_netsuite_id,
          'location_from', o.location_from,
          'unknowns', to_jsonb(o.unknowns),
          'made_at', o.made_at,
          'fixed_at', o.fixed_at,
          'lines', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'line_no', l.line_no,
              'item_id', l.item_id,
              'item_number', l.item_number,
              'description', l.description,
              'item_type', l.item_type,
              'quantity', l.quantity::text
            ) ORDER BY l.line_no), '[]'::jsonb)
            FROM own_lines l
            WHERE l.invoice_id = o.netsuite_id
          )
        ),
        'netsuite', (
          SELECT jsonb_build_object(
            'number', t.tranid,
            'type', t.tran_type,
            'date', to_char(t.trandate, 'YYYY-MM-DD'),
            'gone', t.gone_at IS NOT NULL,
            'lines', (
              SELECT coalesce(jsonb_agg(jsonb_build_object(
                'line_id', tl.line_id,
                'item_id', tl.item_id,
                'location_id', tl.location_id,
                'quantity', tl.quantity::text,
                'moves_stock', tl.moves_stock,
                'value', tl.value::text
              ) ORDER BY tl.line_id::bigint), '[]'::jsonb)
              FROM twin_lines tl
              WHERE tl.own_id = o.netsuite_id AND tl.company_id = o.company_id
            )
          )
          FROM twin t
          WHERE t.own_id = o.netsuite_id
        ),
        'netsuite_gl', (
          SELECT jsonb_build_object(
            'posting_month', to_char(b.posting_month, 'YYYY-MM-DD'),
            'entry', (
              SELECT coalesce(jsonb_agg(jsonb_build_object(
                'account_id', e.account_id, 'debit', e.debit::text, 'credit', e.credit::text
              ) ORDER BY e.account_id::bigint), '[]'::jsonb)
              FROM (
                SELECT l.netsuite_account_id AS account_id, sum(l.debit) AS debit, sum(l.credit) AS credit
                FROM public.gl_netsuite_lines l
                JOIN cost c ON c.transaction_id = l.transaction_id AND c.line_id = l.line_id
                WHERE l.transaction_id = o.netsuite_id AND l.company_id = o.company_id
                GROUP BY l.netsuite_account_id
              ) e
            )
          )
          FROM booked b
          WHERE b.own_id = o.netsuite_id
        ),
        'before', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'item_id', b.item_id, 'location_id', b.location_id, 'quantity', b.quantity::text, 'value', b.value::text
          ) ORDER BY b.item_id::bigint, b.location_id NULLS FIRST), '[]'::jsonb)
          FROM before b
          WHERE b.own_id = o.netsuite_id
        ),
        'customer_name', coalesce(
          (SELECT nullif(btrim(c.company_name), '') FROM public.customers c WHERE c.id = o.customer_id),
          (SELECT lc.display_name FROM public.ledger_customers lc
           WHERE lc.source = 'netsuite' AND lc.external_id = 'customer/' || o.customer_netsuite_id),
          (SELECT cl.name FROM public.gl_netsuite_lists cl WHERE cl.kind = 'customer' AND cl.netsuite_id = o.customer_netsuite_id)
        )
      ) ORDER BY o.invoice_date DESC, o.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM own o
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object(
        'number', l.name, 'type', l.details->>'item_type', 'display_name', l.details->>'display_name',
        'parts', CASE WHEN l.details->>'item_type' = 'Kit' THEN l.details->'parts' END
      )), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'item' AND l.netsuite_id IN (
        SELECT item_id FROM billed
        UNION
        SELECT tl.item_id FROM twin_lines tl
      )
    ),
    'locations', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, l.name), '{}'::jsonb)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'location'
    ),
    'accounts', (
      SELECT coalesce(jsonb_object_agg(a.netsuite_account_id, jsonb_build_object('number', a.number, 'name', a.name)), '{}'::jsonb)
      FROM public.gl_accounts a
      WHERE a.netsuite_account_id IN (
        SELECT l.netsuite_account_id FROM public.gl_netsuite_lines l JOIN own o ON o.netsuite_id = l.transaction_id
      )
    )
  )
$$;

-- The accounts the entries of FleetSuite's own copies of one company's invoices post their cost to, for the items each
-- entry books: p_items { <invoice's NetSuite id>: [<item's NetSuite id>, ...] }, a kit's parts among them:
--   items:      { <NetSuite item id>: its asset account (NetSuite's id), or null }, from the copy of NetSuite's items;
--   invoices:   { <NetSuite id>: { <item id>: {
--                 cost:     the account NetSuite's last fulfillment or invoice of the item for the company before this
--                           invoice (by date, then NetSuite's id) debited its cost to: a fulfillment's outside the
--                           inventory accounts, an invoice's to a cost of goods sold account; null when NetSuite hasn't
--                           shipped or sold it before,
--                 from:     { netsuite_id, number, date, type } that fulfillment ('ItemShip') or invoice ('CustInvc'),
--                 netsuite: the account this invoice debited the item's cost to, for saying why an entry differs } } };
--   usual_cost: the account most of the company's fulfillments debit their cost to, as gl_own_stock_accounts gives it,
--               for an item NetSuite hasn't shipped or sold before; null when no invoice is asked about or none does.
-- Invoices of another company, or that FleetSuite has no own copy of, are left out. An item's cost line is found by its
-- line id, as gl_own_stock_accounts finds a fulfillment's: the copy of NetSuite's stock moves keeps every line that names
-- an item, an invoice's cost of goods line among them.
CREATE OR REPLACE FUNCTION public.gl_own_invoice_cost_accounts(p_company TEXT, p_items JSONB)
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
  cogs AS (
    SELECT a.netsuite_account_id AS id
    FROM public.gl_accounts a
    WHERE a.account_type = 'cost_of_goods_sold' AND a.netsuite_account_id IS NOT NULL
  ),
  wanted AS (
    SELECT DISTINCT o.netsuite_id, o.invoice_date, i.item_id
    FROM jsonb_each(CASE WHEN jsonb_typeof(p_items) = 'object' THEN p_items ELSE '{}'::jsonb END) AS w(invoice_id, items)
    JOIN public.gl_own_invoices o ON o.netsuite_id = w.invoice_id AND o.company_id = (SELECT id FROM company)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(w.items) = 'array' THEN w.items ELSE '[]'::jsonb END
    ) AS i(item_id)
    WHERE i.item_id ~ '^[0-9]+$'
  ),
  learned AS (
    SELECT w.netsuite_id, w.item_id, c.account, c.document_id, c.number, c.date, c.type,
           (
             SELECT l.netsuite_account_id
             FROM public.gl_netsuite_stock_lines s
             JOIN public.gl_netsuite_lines l ON l.transaction_id = s.document_id AND l.line_id = s.line_id
             WHERE s.document_id = w.netsuite_id AND s.item_id = w.item_id
               AND s.company_id = (SELECT id FROM company) AND l.company_id = (SELECT id FROM company)
               AND l.debit > l.credit AND l.netsuite_account_id IN (SELECT id FROM cogs)
             ORDER BY l.debit - l.credit DESC, l.netsuite_account_id::bigint
             LIMIT 1
           ) AS this_account
    FROM wanted w
    LEFT JOIN LATERAL (
      SELECT l.netsuite_account_id AS account, d.netsuite_id AS document_id, d.tranid AS number, d.trandate AS date,
             d.tran_type AS type
      FROM public.gl_netsuite_stock_lines s
      JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
      JOIN public.gl_netsuite_lines l ON l.transaction_id = s.document_id AND l.line_id = s.line_id
      WHERE s.item_id = w.item_id
        AND s.company_id = (SELECT id FROM company)
        AND l.company_id = (SELECT id FROM company)
        AND d.gone_at IS NULL
        AND (d.trandate, d.netsuite_id::bigint) < (w.invoice_date, w.netsuite_id::bigint)
        AND l.debit > l.credit
        AND (
          (d.tran_type = 'ItemShip' AND l.netsuite_account_id NOT IN (SELECT id FROM inventory))
          OR (d.tran_type = 'CustInvc' AND l.netsuite_account_id IN (SELECT id FROM cogs))
        )
      ORDER BY d.trandate DESC, d.netsuite_id::bigint DESC, l.debit - l.credit DESC, l.netsuite_account_id::bigint
      LIMIT 1
    ) c ON true
  ),
  usual AS (
    SELECT l.netsuite_account_id AS account
    FROM public.gl_netsuite_transactions t
    JOIN public.gl_netsuite_lines l ON l.transaction_id = t.netsuite_id
    WHERE EXISTS (SELECT 1 FROM wanted)
      AND t.tran_type = 'ItemShip'
      AND l.company_id = (SELECT id FROM company)
      AND l.debit > l.credit
      AND l.netsuite_account_id NOT IN (SELECT id FROM inventory)
    GROUP BY l.netsuite_account_id
    ORDER BY count(DISTINCT l.transaction_id) DESC, l.netsuite_account_id::bigint
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'items', (
      SELECT coalesce(jsonb_object_agg(i.item_id, (
        SELECT CASE WHEN x.details->>'asset_account' ~ '^[0-9]+$' THEN x.details->>'asset_account' END
        FROM public.gl_netsuite_lists x
        WHERE x.kind = 'item' AND x.netsuite_id = i.item_id
      )), '{}'::jsonb)
      FROM (SELECT DISTINCT item_id FROM wanted) i
    ),
    'invoices', (
      SELECT coalesce(jsonb_object_agg(f.netsuite_id, f.items), '{}'::jsonb)
      FROM (
        SELECT l.netsuite_id, jsonb_object_agg(l.item_id, jsonb_build_object(
          'cost', l.account,
          'from', CASE WHEN l.document_id IS NOT NULL THEN jsonb_build_object(
            'netsuite_id', l.document_id, 'number', l.number, 'date', to_char(l.date, 'YYYY-MM-DD'), 'type', l.type
          ) END,
          'netsuite', l.this_account
        )) AS items
        FROM learned l
        GROUP BY l.netsuite_id
      ) f
    ),
    'usual_cost', (SELECT account FROM usual)
  )
$$;

-- One company's NetSuite stock documents p_ids (NetSuite's ids), as gl_stock_month (migration 395) gives a month's:
-- every item fulfillment, item receipt, inventory adjustment or transfer, assembly build or unbuild among them that the
-- copy of NetSuite's GL has a line of for the company, and since migration 517 every invoice and credit memo among them
-- with a cost line for it (gl_netsuite_cost_lines), each with netsuite_id, type, number, date, posting_month, companies
-- and its lines for the company (an invoice's or credit memo's cost lines only).
CREATE OR REPLACE FUNCTION public.gl_stock_documents(p_company TEXT, p_ids TEXT[])
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  named AS (
    SELECT t.netsuite_id, t.tran_type, t.tranid, t.trandate, t.posting_month
    FROM public.gl_netsuite_transactions t
    WHERE t.netsuite_id = ANY (coalesce(p_ids, ARRAY[]::text[]))
  ),
  cost AS MATERIALIZED (
    -- The cost lines of the invoices and credit memos named, read once for each month they're booked into.
    SELECT cl.transaction_id, cl.line_id
    FROM (SELECT DISTINCT posting_month FROM named WHERE tran_type IN ('CustInvc', 'CustCred')) m
    CROSS JOIN LATERAL public.gl_netsuite_cost_lines(p_company, m.posting_month) cl
    WHERE cl.transaction_id IN (SELECT netsuite_id FROM named)
  ),
  documents AS (
    SELECT n.*
    FROM named n
    WHERE (
        n.tran_type IN ('ItemShip', 'ItemRcpt', 'InvAdjst', 'InvTrnfr', 'Build', 'Unbuild') AND EXISTS (
          SELECT 1 FROM public.gl_netsuite_lines l
          WHERE l.transaction_id = n.netsuite_id AND l.company_id = (SELECT id FROM company)
        )
      )
      OR n.netsuite_id IN (SELECT transaction_id FROM cost)
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
  FROM documents m
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.gl_own_invoice_cost_pairs(date, date, text)',
    'public.gl_own_invoice_cost_accounts(text, jsonb)',
    'public.gl_stock_documents(text, text[])'
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

COMMENT ON FUNCTION public.gl_own_invoice_cost_pairs(date, date, text) IS 'Migration 517: FleetSuite''s own invoices made without a sales order on some days, or one, each next to NetSuite''s invoice as the copies of its stock moves and general ledger have it (its cost lines alone), with FleetSuite''s count and value of each item named just before it and each kit''s parts, for the posting job and the Own invoices page. Service role only.';
COMMENT ON FUNCTION public.gl_own_invoice_cost_accounts(text, jsonb) IS 'Migration 517: the accounts the entries of FleetSuite''s own copies of some invoices post their cost to: each item''s asset account, the cost account NetSuite''s last fulfillment or invoice of each item before each invoice used, and the one most fulfillments use (src/lib/books/own-stock-posting.ts). Service role only.';
COMMENT ON FUNCTION public.gl_stock_documents(text, text[]) IS 'Migrations 456 and 517: one company''s NetSuite stock documents named by id, and since 517 its invoices and credit memos with cost lines (those lines alone), each with its lines for the company from the copy of NetSuite''s GL, as gl_stock_month gives a month''s, for the Own pages. Service role only.';
