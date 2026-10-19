-- Migration 404: stock by item breaks down, account by account, where
-- NetSuite's ledger and the items it keeps in stock part (owner decision
-- 2026-10-19, thread "Replacing NetSuite with FleetSuite", "Break it down").
--
-- Stock by item puts the value of the items NetSuite keeps in stock next to
-- what the copy of NetSuite's general ledger holds on the inventory accounts
-- (migration 402), as one line. On the real books that line lumped together
-- the inventory asset account, which held much less than the items were
-- worth, and the fixed asset accounts some stocked items name (equipment,
-- vehicles), which held a lot more, so the one difference left said nothing
-- of either. gl_stock_ledger_parts gives, for each company and inventory
-- account:
--   ledger   what the ledger held on December 31, 2024 (the GL copy's
--            starting entry) and what posted to it since;
--   items    what the stocked items started at, each one's starting value
--            on its own asset account (on the inventory account most of them
--            name, when its own isn't one), and what their stock lines posted
--            to it since, as gl_stock_items values them;
--   entries  the documents since that posted to it on no stocked item's
--            stock line (a journal entry, say, or a bill for a truck), the
--            biggest first, at most p_limit (1 to 1000) of them, with how
--            many there are and what they come to, in all and by kind.
-- So the ledger less the items is the starting difference plus the entries.
--
-- Reads only. Service role only, as the rest of stock by item.
-- docs/books.md "Stock by item".

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
  SELECT jsonb_build_object('parts', coalesce((
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
      )
    ) ORDER BY c.code, a.number NULLS LAST, p.account_id)
    FROM parts p
    JOIN public.gl_companies c ON c.id = p.company_id
    LEFT JOIN public.gl_accounts a ON a.netsuite_account_id = p.account_id
    WHERE p.ledger_start <> 0 OR p.ledger_moves <> 0 OR p.items_start <> 0 OR p.items_moves <> 0
  ), '[]'::jsonb))
$$;

-- ── Access: service role only ──────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.gl_stock_ledger_parts(integer) FROM PUBLIC;
DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_stock_ledger_parts(integer) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gl_stock_ledger_parts(integer) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_stock_ledger_parts(integer) IS 'Migration 404: per company and inventory account, what the GL copy held on December 31, 2024 and posted since, next to the stocked items'' start and moves, and the documents since that posted to it on no stocked item''s stock line, biggest first (at most p_limit). Service role only.';
