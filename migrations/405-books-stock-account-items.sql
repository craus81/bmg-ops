-- Migration 405: stock by item names the stocked items behind each inventory
-- account other than the usual one, and leaves out items NetSuite no longer
-- has (owner decision 2026-10-19, thread "Replacing NetSuite with
-- FleetSuite", "Name it").
--
-- The inventory accounts are the asset accounts of the items NetSuite keeps
-- in stock (migration 402), inactive items and items gone from NetSuite
-- included. On the real books, after a fixed asset account had left Stock by
-- item's ledger line once the one stocked item naming it was set right in
-- NetSuite, another stayed on it with no stock on it at all, and no active
-- item named it, so nothing on the page said what kept it there. Now:
--   * an item gone from NetSuite (gone_at, migration 363) no longer makes
--     its asset account an inventory account: NetSuite won't delete an item
--     anything was received or shipped on, so it held no stock;
--   * gl_stock_ledger_parts (migration 404) gives each account whether it's
--     the usual one (the inventory account most stocked items name), how
--     many stocked items NetSuite still has name it, and, on any other
--     account, the first 20 of them by name, active or not, so the owner can
--     set them right in NetSuite; and the usual account itself.
--
-- Reads only. Service role only, as the rest of stock by item.
-- docs/books.md "Stock by item".

-- ── Reads ──────────────────────────────────────────────────────────────────

-- The inventory accounts, as NetSuite ids: the asset accounts of the items
-- NetSuite keeps in stock and still has, that the chart of accounts has as
-- asset accounts. The copy reads each item's starting value from these.
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
    WHERE i.kind = 'item' AND i.details->>'item_type' IN ('InvtPart', 'Assembly') AND i.gone_at IS NULL
      AND acct.account_type IN ('other_current_asset', 'fixed_asset', 'other_asset')
      AND i.details->>'asset_account' ~ '^[0-9]+$'
  ) a
$$;

-- As migration 404's, with, on each account, whether it's the usual one, how
-- many stocked items NetSuite still has name it, and on any other account
-- the first 20 of them by name; and the usual account.
CREATE OR REPLACE FUNCTION public.gl_stock_ledger_parts(p_limit INTEGER)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH inventory AS (
    SELECT id FROM jsonb_array_elements_text(public.gl_stock_inventory_accounts()) AS a(id)
  ),
  stocked AS (
    -- The items NetSuite keeps in stock (bill-rule.ts STOCK_TYPES), inactive ones too, as gl_stock_items values them.
    SELECT i.netsuite_id AS item_id, i.details->>'asset_account' AS asset_account
    FROM public.gl_netsuite_lists i
    WHERE i.kind = 'item' AND i.details->>'item_type' IN ('InvtPart', 'Assembly')
  ),
  usual AS (
    -- The inventory account most stocked items name.
    SELECT asset_account AS id
    FROM stocked
    WHERE asset_account IN (SELECT id FROM inventory)
    GROUP BY asset_account
    ORDER BY count(*) DESC, asset_account::bigint
    LIMIT 1
  ),
  named AS (
    -- The stocked items NetSuite still has, each with the inventory account it names as its asset account.
    SELECT i.details->>'asset_account' AS account_id, i.netsuite_id, i.name, i.details->>'display_name' AS display_name, i.active
    FROM public.gl_netsuite_lists i
    WHERE i.kind = 'item' AND i.details->>'item_type' IN ('InvtPart', 'Assembly') AND i.gone_at IS NULL
      AND i.details->>'asset_account' IN (SELECT id FROM inventory)
  ),
  item_account AS (
    -- Where a stocked item's starting value counts: its own asset account, else the usual one.
    SELECT s.item_id,
           CASE WHEN s.asset_account IN (SELECT id FROM inventory) THEN s.asset_account ELSE (SELECT id FROM usual) END AS account_id
    FROM stocked s
  ),
  live AS (
    -- The stocked items' lines on the stock documents NetSuite still has (gl_stock_items' valued).
    SELECT sl.document_id, sl.line_id, sl.company_id
    FROM public.gl_netsuite_stock_lines sl
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = sl.document_id
    WHERE d.gone_at IS NULL AND sl.item_id IN (SELECT item_id FROM stocked)
  ),
  posted AS (
    -- Every line of the GL copy on an inventory account; item_company is the
    -- company of the stocked item's stock line that carries it, if one does.
    SELECT l.company_id, l.netsuite_account_id AS account_id, l.transaction_id, l.line_id,
           l.debit - l.credit AS amount, l.entity_id, l.memo, s.company_id AS item_company
    FROM public.gl_netsuite_lines l
    LEFT JOIN live s ON s.document_id = l.transaction_id AND s.line_id = l.line_id
    WHERE l.netsuite_account_id IN (SELECT id FROM inventory)
  ),
  ledger_start AS (
    SELECT o.company_id, o.netsuite_account_id AS account_id, sum(o.debit - o.credit) AS amount
    FROM public.gl_netsuite_opening o
    WHERE o.netsuite_account_id IN (SELECT id FROM inventory)
    GROUP BY o.company_id, o.netsuite_account_id
  ),
  ledger_moves AS (
    SELECT company_id, account_id, sum(amount) AS amount
    FROM posted
    GROUP BY company_id, account_id
  ),
  items_start AS (
    SELECT o.company_id, a.account_id, sum(o.value) AS amount
    FROM public.gl_netsuite_stock_opening o
    JOIN item_account a ON a.item_id = o.item_id
    WHERE a.account_id IS NOT NULL
    GROUP BY o.company_id, a.account_id
  ),
  items_moves AS (
    SELECT item_company AS company_id, account_id, sum(amount) AS amount
    FROM posted
    WHERE item_company IS NOT NULL
    GROUP BY item_company, account_id
  ),
  entries AS (
    -- Each document that posted to an account on no stocked item's stock line, with what it posted there.
    SELECT p.company_id, p.account_id, p.transaction_id AS doc, sum(p.amount) AS amount,
           (array_agg(p.entity_id ORDER BY p.line_id::bigint) FILTER (WHERE p.entity_id IS NOT NULL))[1] AS entity_id,
           (array_agg(btrim(p.memo) ORDER BY p.line_id::bigint) FILTER (WHERE btrim(p.memo) <> ''))[1] AS memo
    FROM posted p
    WHERE p.item_company IS NULL
    GROUP BY p.company_id, p.account_id, p.transaction_id
    HAVING sum(p.amount) <> 0
  ),
  ranked AS (
    SELECT e.*, t.tran_type, t.tranid, t.trandate, t.posting_month,
           row_number() OVER (
             PARTITION BY e.company_id, e.account_id
             ORDER BY abs(e.amount) DESC, t.trandate NULLS LAST, length(e.doc), e.doc
           ) AS n
    FROM entries e
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = e.doc
  ),
  parts AS (
    SELECT k.company_id, k.account_id,
           coalesce(ls.amount, 0) AS ledger_start, coalesce(lm.amount, 0) AS ledger_moves,
           coalesce(st.amount, 0) AS items_start, coalesce(im.amount, 0) AS items_moves
    FROM (
      SELECT company_id, account_id FROM ledger_start
      UNION SELECT company_id, account_id FROM ledger_moves
      UNION SELECT company_id, account_id FROM items_start
      UNION SELECT company_id, account_id FROM items_moves
    ) k
    LEFT JOIN ledger_start ls ON ls.company_id = k.company_id AND ls.account_id = k.account_id
    LEFT JOIN ledger_moves lm ON lm.company_id = k.company_id AND lm.account_id = k.account_id
    LEFT JOIN items_start st ON st.company_id = k.company_id AND st.account_id = k.account_id
    LEFT JOIN items_moves im ON im.company_id = k.company_id AND im.account_id = k.account_id
  )
  SELECT jsonb_build_object(
    'parts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'company', c.code,
        'account_id', p.account_id,
        'number', a.number,
        'name', a.name,
        'type', a.account_type,
        'ledger_start', p.ledger_start::text,
        'ledger_moves', p.ledger_moves::text,
        'items_start', p.items_start::text,
        'items_moves', p.items_moves::text,
        'entries', (SELECT count(*) FROM ranked r WHERE r.company_id = p.company_id AND r.account_id = p.account_id),
        'entries_total', (
          SELECT coalesce(sum(r.amount), 0)::text FROM ranked r WHERE r.company_id = p.company_id AND r.account_id = p.account_id
        ),
        'kinds', (
          SELECT coalesce(jsonb_agg(jsonb_build_object('type', x.tran_type, 'count', x.documents, 'total', x.total::text)
                                    ORDER BY abs(x.total) DESC, x.tran_type), '[]'::jsonb)
          FROM (
            SELECT r.tran_type, count(*) AS documents, sum(r.amount) AS total
            FROM ranked r
            WHERE r.company_id = p.company_id AND r.account_id = p.account_id
            GROUP BY r.tran_type
          ) x
        ),
        'rows', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'doc', r.doc,
            'type', r.tran_type,
            'number', r.tranid,
            'date', to_char(r.trandate, 'YYYY-MM-DD'),
            'month', to_char(r.posting_month, 'YYYY-MM-DD'),
            -- The vendor the account's own lines name, else the document's first line that names one.
            'name', (
              SELECT v.name
              FROM public.gl_netsuite_lists v
              WHERE v.kind = 'vendor' AND v.netsuite_id = coalesce(r.entity_id, (
                SELECT l.entity_id FROM public.gl_netsuite_lines l
                WHERE l.transaction_id = r.doc AND l.company_id = r.company_id AND l.entity_id IS NOT NULL
                ORDER BY l.line_id::bigint
                LIMIT 1
              ))
            ),
            'memo', r.memo,
            'amount', r.amount::text
          ) ORDER BY r.n), '[]'::jsonb)
          FROM ranked r
          WHERE r.company_id = p.company_id AND r.account_id = p.account_id
            AND r.n <= greatest(1, least(coalesce(p_limit, 100), 1000))
        ),
        'usual', p.account_id IS NOT DISTINCT FROM (SELECT id FROM usual),
        'named', (SELECT count(*) FROM named n WHERE n.account_id = p.account_id),
        -- On any account but the usual one, the stocked items that name it, the first 20 by name.
        'named_items', CASE WHEN p.account_id IS DISTINCT FROM (SELECT id FROM usual) THEN (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'netsuite_id', x.netsuite_id, 'name', x.name, 'display_name', x.display_name, 'active', x.active
          ) ORDER BY x.name, x.netsuite_id), '[]'::jsonb)
          FROM (
            SELECT n.netsuite_id, n.name, n.display_name, n.active
            FROM named n
            WHERE n.account_id = p.account_id
            ORDER BY n.name, n.netsuite_id
            LIMIT 20
          ) x
        ) ELSE '[]'::jsonb END
      ) ORDER BY c.code, a.number NULLS LAST, p.account_id)
      FROM parts p
      JOIN public.gl_companies c ON c.id = p.company_id
      LEFT JOIN public.gl_accounts a ON a.netsuite_account_id = p.account_id
      WHERE p.ledger_start <> 0 OR p.ledger_moves <> 0 OR p.items_start <> 0 OR p.items_moves <> 0
    ), '[]'::jsonb),
    'usual', (
      SELECT jsonb_build_object('netsuite_id', u.id, 'number', a.number, 'name', a.name)
      FROM usual u
      LEFT JOIN public.gl_accounts a ON a.netsuite_account_id = u.id
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.gl_stock_inventory_accounts()', 'public.gl_stock_ledger_parts(integer)'] LOOP
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

COMMENT ON FUNCTION public.gl_stock_inventory_accounts() IS 'Migration 405: the asset accounts of the items NetSuite keeps in stock (InvtPart, Assembly) and still has, that the chart of accounts has as asset accounts, as NetSuite ids. Service role only.';
COMMENT ON FUNCTION public.gl_stock_ledger_parts(integer) IS 'Migration 405: per company and inventory account, what the GL copy held on December 31, 2024 and posted since, next to the stocked items'' start and moves, the documents since that posted to it on no stocked item''s stock line, biggest first (at most p_limit), and the stocked items that name it (listed on any account but the usual one); and the usual account. Service role only.';
