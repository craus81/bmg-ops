-- Migration 402: stock by item values only what NetSuite keeps in stock
-- (field bug 2026-10-18, thread "Replacing NetSuite with FleetSuite").
--
-- Migration 401 took every account a NetSuite item names as its asset
-- account for an inventory account. Some items in NetSuite name the cost of
-- goods sold account and fixed asset accounts there, so an item's value kept
-- the cost of goods posted on its fulfillments and invoices, and its starting
-- value took in everything posted to those accounts before 2025. On the first
-- look at the real books every count matched NetSuite's and the values were
-- many times NetSuite's.
--
-- Now:
--   * the inventory accounts are the asset accounts of the items NetSuite
--     keeps in stock (inventory items and assemblies: item_type InvtPart or
--     Assembly, as bill-rule.ts STOCK_TYPES), and only the ones the chart of
--     accounts has as asset accounts;
--   * only an item NetSuite keeps in stock has a value: what NetSuite posted
--     to an inventory account on its lines, from its starting value on
--     December 31, 2024.
-- The starting values were read with the old accounts. The copy reads them
-- again with these on its next run (Copy now on Stock by item, or :43 on odd
-- hours); until then a stocked item's starting value is the old one.
--
-- Replaces gl_stock_inventory_accounts, gl_stock_items and
-- gl_stock_item_moves; what they return keeps its shape. Service role only,
-- as before. docs/books.md "Stock by item".

-- ── Reads ──────────────────────────────────────────────────────────────────

-- The inventory accounts, as NetSuite ids: the asset accounts of the items
-- NetSuite keeps in stock, as the copy of NetSuite's lists (migration 363)
-- names them, that the chart of accounts has as asset accounts. The copy
-- reads each item's starting value from these.
CREATE OR REPLACE FUNCTION public.gl_stock_inventory_accounts()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(a.id ORDER BY a.id::bigint), '[]'::jsonb)
  FROM (
    SELECT DISTINCT i.details->>'asset_account' AS id
    FROM public.gl_netsuite_lists i
    JOIN public.gl_accounts acct ON acct.netsuite_account_id = i.details->>'asset_account'
    WHERE i.kind = 'item' AND i.details->>'item_type' IN ('InvtPart', 'Assembly')
      AND acct.account_type IN ('other_current_asset', 'fixed_asset', 'other_asset')
      AND i.details->>'asset_account' ~ '^[0-9]+$'
  ) a
$$;

-- Every item FleetSuite counts, at each location, for every company, next to
-- NetSuite's own counts (src/lib/books/stock-items.ts compares them):
--   rows      per company, item and location: the starting count and value
--             (December 31, 2024), the count and value now (the start plus
--             every copied line that moves stock, and what NetSuite posted to
--             an inventory account on the item's lines; only an item NetSuite
--             keeps in stock has a value), how many documents moved it and
--             the latest one's date;
--   netsuite  NetSuite's own counts as last read (location_id null when
--             NetSuite gave each item's company-wide count), and when;
--   items     the names of the items either side has, from the copy of
--             NetSuite's items (migration 363);
--   locations every location in that copy, with its subsidiary;
--   ledger    per company, what the copy of NetSuite's general ledger holds
--             on the inventory accounts: its starting balance plus every line
--             since, so the items' value can be put next to it;
--   accounts  the inventory accounts (gl_stock_inventory_accounts).
-- Quantities and amounts are decimal strings, debit positive.
CREATE OR REPLACE FUNCTION public.gl_stock_items()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH stocked AS (
    -- The items NetSuite keeps in stock (bill-rule.ts STOCK_TYPES); only they have a value here.
    SELECT i.netsuite_id AS item_id
    FROM public.gl_netsuite_lists i
    WHERE i.kind = 'item' AND i.details->>'item_type' IN ('InvtPart', 'Assembly')
  ),
  asset_accounts AS (
    SELECT id FROM jsonb_array_elements_text(public.gl_stock_inventory_accounts()) AS a(id)
  ),
  live AS (
    SELECT s.document_id, s.line_id, s.company_id, s.item_id, s.location_id, s.quantity, s.moves_stock, d.trandate
    FROM public.gl_netsuite_stock_lines s
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
    WHERE d.gone_at IS NULL
  ),
  moved AS (
    SELECT company_id, item_id, location_id, sum(quantity) AS quantity,
           count(DISTINCT document_id) AS documents, max(trandate) AS last_date
    FROM live
    WHERE moves_stock
    GROUP BY company_id, item_id, location_id
  ),
  valued AS (
    SELECT s.company_id, s.item_id, s.location_id, sum(l.debit - l.credit) AS value
    FROM public.gl_netsuite_lines l
    JOIN live s ON s.document_id = l.transaction_id AND s.line_id = l.line_id
    WHERE l.netsuite_account_id IN (SELECT id FROM asset_accounts)
      AND s.item_id IN (SELECT item_id FROM stocked)
    GROUP BY s.company_id, s.item_id, s.location_id
  ),
  keyed AS (
    SELECT company_id, item_id, location_id FROM public.gl_netsuite_stock_opening
    WHERE quantity <> 0 OR item_id IN (SELECT item_id FROM stocked)
    UNION
    SELECT company_id, item_id, location_id FROM moved
    UNION
    SELECT company_id, item_id, location_id FROM valued
  ),
  counted AS (
    SELECT c.code AS company, k.item_id, k.location_id,
           coalesce(o.quantity, 0) AS opening_quantity,
           CASE WHEN k.item_id IN (SELECT item_id FROM stocked) THEN coalesce(o.value, 0) ELSE 0 END AS opening_value,
           coalesce(o.quantity, 0) + coalesce(m.quantity, 0) AS quantity,
           CASE WHEN k.item_id IN (SELECT item_id FROM stocked) THEN coalesce(o.value, 0) ELSE 0 END
             + coalesce(v.value, 0) AS value,
           coalesce(m.documents, 0) AS documents, m.last_date
    FROM keyed k
    JOIN public.gl_companies c ON c.id = k.company_id
    LEFT JOIN public.gl_netsuite_stock_opening o
      ON o.company_id = k.company_id AND o.item_id = k.item_id AND o.location_id IS NOT DISTINCT FROM k.location_id
    LEFT JOIN moved m
      ON m.company_id = k.company_id AND m.item_id = k.item_id AND m.location_id IS NOT DISTINCT FROM k.location_id
    LEFT JOIN valued v
      ON v.company_id = k.company_id AND v.item_id = k.item_id AND v.location_id IS NOT DISTINCT FROM k.location_id
  ),
  named AS (
    SELECT item_id FROM counted
    UNION
    SELECT item_id FROM public.gl_netsuite_stock_counts
  )
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'company', r.company, 'item_id', r.item_id, 'location_id', r.location_id,
        'opening_quantity', r.opening_quantity::text, 'opening_value', r.opening_value::text,
        'quantity', r.quantity::text, 'value', r.value::text,
        'documents', r.documents, 'last_date', to_char(r.last_date, 'YYYY-MM-DD')
      ) ORDER BY r.item_id::bigint, r.location_id NULLS FIRST, r.company)
      FROM counted r
    ), '[]'::jsonb),
    'netsuite', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'item_id', n.item_id, 'location_id', n.location_id, 'quantity', n.quantity::text, 'value', n.value::text
      ) ORDER BY n.item_id::bigint, n.location_id NULLS FIRST)
      FROM public.gl_netsuite_stock_counts n
    ), '[]'::jsonb),
    'netsuite_read_at', (SELECT max(read_at) FROM public.gl_netsuite_stock_counts),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'netsuite_id', i.netsuite_id, 'name', i.name, 'display_name', i.details->>'display_name', 'active', i.active
      ) ORDER BY i.netsuite_id::bigint)
      FROM public.gl_netsuite_lists i
      WHERE i.kind = 'item' AND i.netsuite_id IN (SELECT item_id FROM named)
    ), '[]'::jsonb),
    'locations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'netsuite_id', l.netsuite_id, 'name', l.name, 'subsidiary_id', l.details->>'subsidiary_id'
      ) ORDER BY l.name)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'location'
    ), '[]'::jsonb),
    'ledger', coalesce((
      SELECT jsonb_agg(jsonb_build_object('company', c.code, 'balance', (
        coalesce((
          SELECT sum(o.debit - o.credit) FROM public.gl_netsuite_opening o
          WHERE o.company_id = c.id AND o.netsuite_account_id IN (SELECT id FROM asset_accounts)
        ), 0)
        + coalesce((
          SELECT sum(l.debit - l.credit) FROM public.gl_netsuite_lines l
          WHERE l.company_id = c.id AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)
        ), 0)
      )::text) ORDER BY c.code)
      FROM public.gl_companies c
    ), '[]'::jsonb),
    'accounts', coalesce((SELECT jsonb_agg(id ORDER BY id::bigint) FROM asset_accounts), '[]'::jsonb)
  )
$$;

-- One item's moves since its starting count: every copied NetSuite document
-- that moved it or posted to an inventory account on its lines, per company
-- and location, with how many it moved (the lines that move stock) and the
-- value it posted, oldest first, each with the count and value it left at
-- its location since 2025 (to add to the starting count) and the month
-- NetSuite posted it to, from the GL copy. At most p_limit (1 to 5000) of
-- them, the newest, and how many there are, with what all of them come to
-- at each location (totals). Also the item's starting count and NetSuite's
-- own count at each location, its name, and the locations'.
CREATE OR REPLACE FUNCTION public.gl_stock_item_moves(p_item TEXT, p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF coalesce(p_item, '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: item must be a NetSuite id';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'gl: limit must be from 1 to 5000';
  END IF;

  WITH stocked AS (
    -- The items NetSuite keeps in stock (bill-rule.ts STOCK_TYPES); only they have a value here.
    SELECT i.netsuite_id AS item_id
    FROM public.gl_netsuite_lists i
    WHERE i.kind = 'item' AND i.details->>'item_type' IN ('InvtPart', 'Assembly')
  ),
  asset_accounts AS (
    SELECT id FROM jsonb_array_elements_text(public.gl_stock_inventory_accounts()) AS a(id)
  ),
  live AS (
    SELECT s.document_id, s.line_id, s.company_id, s.location_id, s.quantity, s.moves_stock
    FROM public.gl_netsuite_stock_lines s
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
    WHERE s.item_id = p_item AND d.gone_at IS NULL
  ),
  moved AS (
    SELECT document_id, company_id, location_id,
           sum(quantity) FILTER (WHERE moves_stock) AS quantity, bool_or(moves_stock) AS moves
    FROM live
    GROUP BY document_id, company_id, location_id
  ),
  valued AS (
    SELECT s.document_id, s.company_id, s.location_id, sum(l.debit - l.credit) AS value
    FROM public.gl_netsuite_lines l
    JOIN live s ON s.document_id = l.transaction_id AND s.line_id = l.line_id
    WHERE l.netsuite_account_id IN (SELECT id FROM asset_accounts)
      AND p_item IN (SELECT item_id FROM stocked)
    GROUP BY s.document_id, s.company_id, s.location_id
  ),
  moves AS (
    SELECT m.document_id, m.company_id, m.location_id,
           coalesce(m.quantity, 0) AS quantity, coalesce(v.value, 0) AS value,
           d.tran_type, d.tranid, d.trandate
    FROM moved m
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = m.document_id
    LEFT JOIN valued v
      ON v.document_id = m.document_id AND v.company_id = m.company_id AND v.location_id IS NOT DISTINCT FROM m.location_id
    WHERE m.moves OR coalesce(v.value, 0) <> 0
  ),
  running AS (
    SELECT mv.*,
           sum(mv.quantity) OVER w AS quantity_since,
           sum(mv.value) OVER w AS value_since,
           row_number() OVER (ORDER BY mv.trandate DESC, mv.document_id::bigint DESC, mv.location_id DESC NULLS LAST) AS newest
    FROM moves mv
    WINDOW w AS (
      PARTITION BY mv.company_id, mv.location_id
      ORDER BY mv.trandate, mv.document_id::bigint
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
  )
  SELECT jsonb_build_object(
    'item', (
      SELECT jsonb_build_object('netsuite_id', i.netsuite_id, 'name', i.name, 'display_name', i.details->>'display_name', 'active', i.active)
      FROM public.gl_netsuite_lists i WHERE i.kind = 'item' AND i.netsuite_id = p_item
    ),
    'opening', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'company', c.code, 'location_id', o.location_id, 'quantity', o.quantity::text,
        'value', (CASE WHEN p_item IN (SELECT item_id FROM stocked) THEN o.value ELSE 0 END)::text
      ) ORDER BY o.location_id NULLS FIRST, c.code)
      FROM public.gl_netsuite_stock_opening o JOIN public.gl_companies c ON c.id = o.company_id
      WHERE o.item_id = p_item
    ), '[]'::jsonb),
    'netsuite', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'location_id', n.location_id, 'quantity', n.quantity::text, 'value', n.value::text
      ) ORDER BY n.location_id NULLS FIRST)
      FROM public.gl_netsuite_stock_counts n WHERE n.item_id = p_item
    ), '[]'::jsonb),
    'netsuite_read_at', (SELECT max(read_at) FROM public.gl_netsuite_stock_counts),
    'moves', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'document_id', r.document_id, 'type', r.tran_type, 'number', r.tranid, 'date', to_char(r.trandate, 'YYYY-MM-DD'),
        'company', c.code, 'location_id', r.location_id, 'quantity', r.quantity::text, 'value', r.value::text,
        'quantity_since', r.quantity_since::text, 'value_since', r.value_since::text,
        'posting_month', to_char(t.posting_month, 'YYYY-MM-DD')
      ) ORDER BY r.trandate, r.document_id::bigint, r.location_id NULLS FIRST)
      FROM running r
      JOIN public.gl_companies c ON c.id = r.company_id
      LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = r.document_id
      WHERE r.newest <= p_limit
    ), '[]'::jsonb),
    'count', (SELECT count(*) FROM moves),
    'totals', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'company', c.code, 'location_id', x.location_id, 'quantity', x.quantity::text, 'value', x.value::text
      ) ORDER BY x.location_id NULLS FIRST, c.code)
      FROM (
        SELECT company_id, location_id, sum(quantity) AS quantity, sum(value) AS value
        FROM moves GROUP BY company_id, location_id
      ) x
      JOIN public.gl_companies c ON c.id = x.company_id
    ), '[]'::jsonb),
    'locations', coalesce((
      SELECT jsonb_agg(jsonb_build_object('netsuite_id', l.netsuite_id, 'name', l.name) ORDER BY l.name)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'location'
    ), '[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END;
$$;

-- ── Access: service role only, as migration 401 set it ────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.gl_stock_inventory_accounts()',
    'public.gl_stock_items()',
    'public.gl_stock_item_moves(text, integer)'
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

COMMENT ON FUNCTION public.gl_stock_inventory_accounts() IS 'Migration 402: the asset accounts of the items NetSuite keeps in stock (InvtPart, Assembly) that the chart of accounts has as asset accounts, as NetSuite ids. Service role only.';
COMMENT ON FUNCTION public.gl_stock_items() IS 'Migration 401, valued by migration 402: every item FleetSuite counts at each location, for every company (starting count, count and value now; only an item NetSuite keeps in stock has a value), next to NetSuite''s own counts, with names, the inventory accounts and what the GL copy holds on them. Service role only.';
COMMENT ON FUNCTION public.gl_stock_item_moves(text, integer) IS 'Migration 401, valued by migration 402: one item''s moves since its starting count, per document, company and location, with running counts and values, its starting counts and NetSuite''s own counts. Service role only.';
