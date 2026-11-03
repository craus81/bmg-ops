-- Migration 519: FleetSuite's own books, a gap fixed: the stock a credit memo
-- FleetSuite made puts back on the shelf posts from Books' own copy of it.
--
-- NetSuite Exit Checklist, "Gaps in what's built" (thread "Replacing NetSuite
-- with FleetSuite", 2026-11-03): transfers, assembly builds and counts'
-- adjustments still post from NetSuite's documents, and so did the stock a
-- credit memo puts back on the shelf. A credit memo FleetSuite makes against
-- an invoice (migration 466, switched off until January 1, 2027) puts each
-- part credited with Back to stock on back on the shelf at O'Fallon, and
-- NetSuite books what that's worth on cost lines of the credit memo's own,
-- which the books post apart from the credit (`invoice_cost:<NetSuite id>`,
-- the stock rule). Since migration 518 the credit posts from Books' own copy
-- of the credit memo; now the stock it puts back does too, when what the
-- copy put back matches NetSuite's credit memo and its entry comes out the
-- same, account by account and on the same day, as an invoice's cost does
-- (migration 517; src/lib/books/own-credit-cost-check.ts and
-- own-stock-posting.ts, rule own_credit_memo_cost@1):
--   * gl_own_credit_cost_pairs(from, to, id?, location): Books' own credit
--     memos, each with the lines that put a part back on the shelf, next to
--     NetSuite's credit memo as the copy of its stock moves has it (migration
--     401), with its cost lines in the copy of its general ledger
--     (gl_netsuite_cost_lines, migration 377) and what FleetSuite counted of
--     each item where either side puts it back just before, as
--     gl_own_invoice_cost_pairs gives an invoice's (migration 517): the
--     copy's at `location`, where the credit memo screen books every part
--     that comes back (O'Fallon, the only location that keeps stock); with
--     each kit's parts from the copy of NetSuite's items, since NetSuite puts
--     a kit's parts back, not the kit;
--   * gl_own_credit_cost_accounts(company, items): the accounts those
--     copies' entries post to: each item's asset account, and the cost
--     account NetSuite's last fulfillment, invoice or credit memo of the item
--     before each credit memo put its cost in, or took it back out of, or for
--     an item NetSuite hasn't shipped, sold or credited before, the one most
--     fulfillments debit.
-- No table is added or changed.
--
-- Caller: the service role only, from the posting job and the Books pages'
-- APIs.

-- ── Readers ────────────────────────────────────────────────────────────────

-- Books' own credit memos made from p_from to p_to, or only the one whose NetSuite id is p_netsuite_id, newest first,
-- each next to NetSuite's credit memo:
--   credit_memos: [{ own: the copy, with location_id p_location, where the parts it puts back come back to, and the
--                         lines that put a part back on the shelf that NetSuite may keep in stock (one the copy of
--                         NetSuite's items keeps in stock, a kit, or one it doesn't have or doesn't type) and its type
--                         there (item_type, null when not known),
--                    netsuite: NetSuite's credit memo as the copy of its stock moves has it, with each line that names
--                              an item: its location, quantity (signed, stock back in positive), whether it moves
--                              stock, and its value, what NetSuite posted to an inventory account on it (debit
--                              positive; null when the copy of its general ledger has nothing on the line); null when
--                              the stock copy doesn't have it,
--                    netsuite_gl: { posting_month, entry: what its cost lines posted to each account } once the copy
--                                 of NetSuite's general ledger has the credit memo, else null,
--                    before: [{ item_id, location_id, quantity, value }] what FleetSuite counted of each item at each
--                            location either side names just before the credit memo (the copy's items and their kits'
--                            parts at p_location, NetSuite's where it moved stock), as gl_own_invoice_cost_pairs
--                            counts them,
--                    customer_name }]
--   items:     { <NetSuite item id>: { number, type, display_name, parts } } for the items on either side and every
--              part of a kit among them, kits inside kits too (parts: a kit's, as the copy keeps them; else null)
--   locations: { <NetSuite location id>: name }
--   accounts:  { <NetSuite account id>: { number, name } } for the accounts NetSuite's credit memos posted to
-- Quantities and amounts are decimal strings.
CREATE OR REPLACE FUNCTION public.gl_own_credit_cost_pairs(
  p_from DATE, p_to DATE, p_netsuite_id TEXT DEFAULT NULL, p_location TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH RECURSIVE own AS (
    SELECT o.*
    FROM public.gl_own_credit_memos o
    WHERE CASE WHEN p_netsuite_id IS NOT NULL THEN o.netsuite_id = p_netsuite_id
               ELSE o.credit_date BETWEEN p_from AND p_to END
  ),
  own_lines AS (
    -- The lines that put a part back on the shelf, of an item NetSuite may keep in stock: one the copy of its items keeps
    -- in stock, a kit, or one it doesn't have, or has with no type, which may be.
    SELECT l.credit_memo_id, l.line_no, l.item_netsuite_id AS item_id, l.item_number, l.description, l.quantity,
           nullif(it.details->>'item_type', '') AS item_type
    FROM public.gl_own_credit_memo_lines l
    JOIN own o ON o.netsuite_id = l.credit_memo_id
    LEFT JOIN public.gl_netsuite_lists it ON it.kind = 'item' AND it.netsuite_id = l.item_netsuite_id
    WHERE l.back_to_stock
      AND l.item_netsuite_id ~ '^[0-9]+$'
      AND l.quantity IS NOT NULL AND l.quantity <> 0
      AND coalesce(it.details->>'item_type', '') IN ('', 'InvtPart', 'Assembly', 'Kit')
  ),
  kit_reach AS (
    -- Every item inside a kit the lines put back, a kit inside a kit's too, as deep as the check takes kits apart.
    SELECT ol.credit_memo_id, p.part->>'item' AS item_id, 1 AS depth
    FROM own_lines ol
    JOIN public.gl_netsuite_lists k ON k.kind = 'item' AND k.netsuite_id = ol.item_id AND k.details->>'item_type' = 'Kit'
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(k.details->'parts') = 'array' THEN k.details->'parts' ELSE '[]'::jsonb END
    ) AS p(part)
    WHERE p.part->>'item' ~ '^[0-9]+$'
    UNION
    SELECT r.credit_memo_id, p.part->>'item', r.depth + 1
    FROM kit_reach r
    JOIN public.gl_netsuite_lists k ON k.kind = 'item' AND k.netsuite_id = r.item_id AND k.details->>'item_type' = 'Kit'
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(k.details->'parts') = 'array' THEN k.details->'parts' ELSE '[]'::jsonb END
    ) AS p(part)
    WHERE r.depth < 6 AND p.part->>'item' ~ '^[0-9]+$'
  ),
  credited AS (
    SELECT credit_memo_id, item_id FROM own_lines
    UNION
    SELECT credit_memo_id, item_id FROM kit_reach
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
    -- Each item at each location either side names: the copy's items and their kits' parts where it puts them back,
    -- NetSuite's where it moved stock.
    SELECT o.netsuite_id AS own_id, o.company_id, o.credit_date, c.item_id, p_location AS location_id
    FROM own o
    JOIN credited c ON c.credit_memo_id = o.netsuite_id
    WHERE p_location IS NOT NULL
    UNION
    SELECT o.netsuite_id, o.company_id, o.credit_date, tl.item_id, tl.location_id
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
        AND (d.trandate, d.netsuite_id::bigint) < (p.credit_date, p.own_id::bigint)
    ) mv ON true
    LEFT JOIN LATERAL (
      SELECT sum(l.debit - l.credit) AS value
      FROM public.gl_netsuite_stock_lines s
      JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
      JOIN public.gl_netsuite_lines l ON l.transaction_id = s.document_id AND l.line_id = s.line_id
      WHERE s.item_id = p.item_id AND s.company_id = p.company_id AND s.location_id IS NOT DISTINCT FROM p.location_id
        AND d.gone_at IS NULL
        AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)
        AND (d.trandate, d.netsuite_id::bigint) < (p.credit_date, p.own_id::bigint)
    ) vl ON true
  ),
  booked AS (
    -- The month the copy of NetSuite's general ledger has each credit memo booked into, and the company it's FleetSuite's for.
    SELECT o.netsuite_id AS own_id, c.code AS company, g.posting_month
    FROM own o
    JOIN public.gl_netsuite_transactions g ON g.netsuite_id = o.netsuite_id
    JOIN public.gl_companies c ON c.id = o.company_id
  ),
  cost AS MATERIALIZED (
    -- The credit memos' cost lines, as the stock rule posts them (gl_netsuite_cost_lines), read once for each month.
    SELECT cl.transaction_id, cl.line_id
    FROM (SELECT DISTINCT company, posting_month FROM booked) m
    CROSS JOIN LATERAL public.gl_netsuite_cost_lines(m.company, m.posting_month) cl
    WHERE cl.transaction_id IN (SELECT own_id FROM booked)
  )
  SELECT jsonb_build_object(
    'credit_memos', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'netsuite_id', o.netsuite_id,
          'number', o.netsuite_number,
          'invoice_id', o.invoice_netsuite_id,
          'invoice_number', o.invoice_number,
          'customer_netsuite_id', o.customer_netsuite_id,
          'date', to_char(o.credit_date, 'YYYY-MM-DD'),
          'location_id', p_location,
          'made_at', o.made_at,
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
            WHERE l.credit_memo_id = o.netsuite_id
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
      ) ORDER BY o.credit_date DESC, o.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM own o
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object(
        'number', l.name, 'type', l.details->>'item_type', 'display_name', l.details->>'display_name',
        'parts', CASE WHEN l.details->>'item_type' = 'Kit' THEN l.details->'parts' END
      )), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'item' AND l.netsuite_id IN (
        SELECT item_id FROM credited
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

-- The accounts the entries of Books' own copies of one company's credit memos post the stock they put back to, for
-- the items each entry books: p_items { <credit memo's NetSuite id>: [<item's NetSuite id>, ...] }, a kit's parts
-- among them:
--   items:      { <NetSuite item id>: its asset account (NetSuite's id), or null }, from the copy of NetSuite's items;
--   credits:    { <NetSuite id>: { <item id>: {
--                 cost:     the account NetSuite's last fulfillment, invoice or credit memo of the item for the company
--                           before this credit memo (by date, then NetSuite's id) put its cost in or took it back out
--                           of: a fulfillment's debit outside the inventory accounts, an invoice's debit to a cost of
--                           goods sold account, a credit memo's credit to one; null when NetSuite hasn't shipped, sold
--                           or credited it before,
--                 from:     { netsuite_id, number, date, type } that fulfillment ('ItemShip'), invoice ('CustInvc') or
--                           credit memo ('CustCred'),
--                 netsuite: the account this credit memo took the item's cost back out of, for saying why an entry
--                           differs } } };
--   usual_cost: the account most of the company's fulfillments debit their cost to, as gl_own_stock_accounts gives it,
--               for an item NetSuite hasn't shipped, sold or credited before; null when no credit memo is asked about
--               or none does.
-- Credit memos of another company, or that FleetSuite has no own copy of, are left out. An item's cost line is found
-- by its line id, as gl_own_invoice_cost_accounts finds an invoice's.
CREATE OR REPLACE FUNCTION public.gl_own_credit_cost_accounts(p_company TEXT, p_items JSONB)
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
    SELECT DISTINCT o.netsuite_id, o.credit_date, i.item_id
    FROM jsonb_each(CASE WHEN jsonb_typeof(p_items) = 'object' THEN p_items ELSE '{}'::jsonb END) AS w(credit_memo_id, items)
    JOIN public.gl_own_credit_memos o ON o.netsuite_id = w.credit_memo_id AND o.company_id = (SELECT id FROM company)
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
               AND l.credit > l.debit AND l.netsuite_account_id IN (SELECT id FROM cogs)
             ORDER BY l.credit - l.debit DESC, l.netsuite_account_id::bigint
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
        AND (d.trandate, d.netsuite_id::bigint) < (w.credit_date, w.netsuite_id::bigint)
        AND (
          (d.tran_type = 'ItemShip' AND l.debit > l.credit AND l.netsuite_account_id NOT IN (SELECT id FROM inventory))
          OR (d.tran_type = 'CustInvc' AND l.debit > l.credit AND l.netsuite_account_id IN (SELECT id FROM cogs))
          OR (d.tran_type = 'CustCred' AND l.credit > l.debit AND l.netsuite_account_id IN (SELECT id FROM cogs))
        )
      ORDER BY d.trandate DESC, d.netsuite_id::bigint DESC, abs(l.debit - l.credit) DESC, l.netsuite_account_id::bigint
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
    'credits', (
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

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.gl_own_credit_cost_pairs(date, date, text, text)',
    'public.gl_own_credit_cost_accounts(text, jsonb)'
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

COMMENT ON FUNCTION public.gl_own_credit_cost_pairs(date, date, text, text) IS 'Migration 519: Books'' own credit memos made on some days, or one, each with the lines that put a part back on the shelf, next to NetSuite''s credit memo as the copies of its stock moves and general ledger have it (its cost lines alone), with FleetSuite''s count and value of each item named just before it and each kit''s parts, for the posting job and the Own credit memos page. Service role only.';
COMMENT ON FUNCTION public.gl_own_credit_cost_accounts(text, jsonb) IS 'Migration 519: the accounts the entries of Books'' own copies of some credit memos post the stock they put back to: each item''s asset account, the cost account NetSuite''s last fulfillment, invoice or credit memo of each item before each credit memo used, and the one most fulfillments use (src/lib/books/own-stock-posting.ts). Service role only.';
