-- Migration 495: FleetSuite's own books, part 64 — inventory value at a
-- month's end, tied to the inventory accounts.
--
-- The NetSuite Exit Checklist's "Inventory moves and value" (thread
-- "Replacing NetSuite with FleetSuite"; docs/books.md "Inventory value at a
-- month's end"): what each stocked item was worth at the end of a month, and
-- how that comes to each inventory account on the balance sheet that day,
-- so a month can be closed with stock that ties. Stock by item (migrations
-- 401 to 405) has each item's count and value now; this has them at any
-- month's end from January 2025, as NetSuite's Inventory Valuation report
-- has them as of a period's end.
--
-- gl_stock_month_end(p_month, p_limit) reads the same copies as Stock by
-- item, cut off at the month asked for (its first day, from January 2025):
--   * a document counts in the month NetSuite posted it to, as the copy of
--     its general ledger has it, else in its date's month, so an item's count
--     and value at a month's end are cut off alike and the value ties to the
--     ledger's balance that day;
--   * rows: each company's item at each location at the month's end, its
--     count (its starting count on December 31, 2024 plus every line that
--     moved it through the month) and value (only an item NetSuite keeps in
--     stock has one: its starting value plus what NetSuite posted to an
--     inventory account on its lines through the month), leaving out the ones
--     with none and nothing on them;
--   * parts: each company's inventory account, as gl_stock_ledger_parts
--     (migration 405) breaks it down, at the month's end: what the copy of
--     NetSuite's ledger and the stocked items held on December 31, 2024, what
--     the stocked items' lines posted to it before the month and through it,
--     the month's by kind of document, what the GL copy posted to it through
--     the month, what NetSuite's own totals (gl_netsuite_month_totals) and
--     FleetSuite's own books (gl_lines) moved it by through the month, and
--     the documents through the month that posted to it on no stocked item's
--     stock line, the month's first and then the biggest, at most p_limit
--     (1 to 1000), with how many there are and what they come to, in all, in
--     the month and by kind;
--   * netsuite_through: per company, the latest month NetSuite's own totals
--     have been read for.
-- The balance sheet's starting entry (gl_netsuite_opening) is the same on
-- every side, as on Reports, so each side's balance is it plus what that
-- side moved.
--
-- Reads only, nothing written. Service role only, as the rest of stock by
-- item.

CREATE OR REPLACE FUNCTION public.gl_stock_month_end(p_month DATE, p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'gl: month must be the first day of a month';
  END IF;
  IF p_month < DATE '2025-01-01' THEN
    RAISE EXCEPTION 'gl: month must be from January 2025, when the stock copy starts';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'gl: limit must be from 1 to 1000';
  END IF;

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
    -- The lines of the stock documents NetSuite still has, each with the month its document posted to.
    SELECT sl.document_id, sl.line_id, sl.company_id, sl.item_id, sl.location_id, sl.quantity, sl.moves_stock,
           coalesce(t.posting_month, date_trunc('month', d.trandate)::date) AS month
    FROM public.gl_netsuite_stock_lines sl
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = sl.document_id
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = sl.document_id
    WHERE d.gone_at IS NULL
  ),
  moved AS (
    SELECT company_id, item_id, location_id, sum(quantity) AS quantity
    FROM live
    WHERE moves_stock AND month <= p_month
    GROUP BY company_id, item_id, location_id
  ),
  posted AS (
    -- Every line of the GL copy on an inventory account through the month; item_company and the item and location
    -- name the stocked item's stock line that carries it, if one does.
    SELECT l.company_id, l.netsuite_account_id AS account_id, l.transaction_id, l.line_id, l.posting_month AS month,
           l.debit - l.credit AS amount, l.entity_id, l.memo,
           s.company_id AS item_company, s.item_id, s.location_id
    FROM public.gl_netsuite_lines l
    LEFT JOIN live s
      ON s.document_id = l.transaction_id AND s.line_id = l.line_id AND s.item_id IN (SELECT item_id FROM stocked)
    WHERE l.netsuite_account_id IN (SELECT id FROM inventory) AND l.posting_month <= p_month
  ),
  valued AS (
    SELECT item_company AS company_id, item_id, location_id, sum(amount) AS value
    FROM posted
    WHERE item_company IS NOT NULL
    GROUP BY item_company, item_id, location_id
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
    SELECT k.company_id, k.item_id, k.location_id,
           coalesce(o.quantity, 0) + coalesce(m.quantity, 0) AS quantity,
           CASE WHEN k.item_id IN (SELECT item_id FROM stocked) THEN coalesce(o.value, 0) ELSE 0 END
             + coalesce(v.value, 0) AS value
    FROM keyed k
    LEFT JOIN public.gl_netsuite_stock_opening o
      ON o.company_id = k.company_id AND o.item_id = k.item_id AND o.location_id IS NOT DISTINCT FROM k.location_id
    LEFT JOIN moved m
      ON m.company_id = k.company_id AND m.item_id = k.item_id AND m.location_id IS NOT DISTINCT FROM k.location_id
    LEFT JOIN valued v
      ON v.company_id = k.company_id AND v.item_id = k.item_id AND v.location_id IS NOT DISTINCT FROM k.location_id
  ),
  shown AS (
    SELECT * FROM counted WHERE quantity <> 0 OR value <> 0
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
    SELECT item_company AS company_id, account_id,
           coalesce(sum(amount) FILTER (WHERE month < p_month), 0) AS before,
           sum(amount) AS amount
    FROM posted
    WHERE item_company IS NOT NULL
    GROUP BY item_company, account_id
  ),
  month_moves AS (
    -- What the stocked items' stock lines posted to each account in the month, by kind of document.
    SELECT p.item_company AS company_id, p.account_id, t.tran_type, count(DISTINCT p.transaction_id) AS documents,
           sum(p.amount) AS total
    FROM posted p
    JOIN public.gl_netsuite_transactions t ON t.netsuite_id = p.transaction_id
    WHERE p.item_company IS NOT NULL AND p.month = p_month
    GROUP BY p.item_company, p.account_id, t.tran_type
  ),
  netsuite_moves AS (
    -- What NetSuite's own totals moved each inventory account by through the month.
    SELECT t.company_id, t.netsuite_account_id AS account_id, sum(t.debit - t.credit) AS amount
    FROM public.gl_netsuite_month_totals t
    WHERE t.netsuite_account_id IN (SELECT id FROM inventory) AND t.month <= p_month
    GROUP BY t.company_id, t.netsuite_account_id
  ),
  books_moves AS (
    -- What FleetSuite's own books moved each inventory account by through the month.
    SELECT l.company_id, a.netsuite_account_id AS account_id, sum(l.debit - l.credit) AS amount
    FROM public.gl_lines l
    JOIN public.gl_accounts a ON a.id = l.account_id
    WHERE a.netsuite_account_id IN (SELECT id FROM inventory) AND l.entry_date < (p_month + INTERVAL '1 month')::date
    GROUP BY l.company_id, a.netsuite_account_id
  ),
  entries AS (
    -- Each document through the month that posted to an account on no stocked item's stock line, with what it posted there.
    SELECT p.company_id, p.account_id, p.transaction_id AS doc, max(p.month) AS month, sum(p.amount) AS amount,
           (array_agg(p.entity_id ORDER BY p.line_id::bigint) FILTER (WHERE p.entity_id IS NOT NULL))[1] AS entity_id,
           (array_agg(btrim(p.memo) ORDER BY p.line_id::bigint) FILTER (WHERE btrim(p.memo) <> ''))[1] AS memo
    FROM posted p
    WHERE p.item_company IS NULL
    GROUP BY p.company_id, p.account_id, p.transaction_id
    HAVING sum(p.amount) <> 0
  ),
  ranked AS (
    SELECT e.*, t.tran_type, t.tranid, t.trandate,
           row_number() OVER (
             PARTITION BY e.company_id, e.account_id
             ORDER BY (e.month = p_month) DESC, abs(e.amount) DESC, t.trandate NULLS LAST, length(e.doc), e.doc
           ) AS n
    FROM entries e
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = e.doc
  ),
  parts AS (
    SELECT k.company_id, k.account_id,
           coalesce(ls.amount, 0) AS ledger_start, coalesce(lm.amount, 0) AS ledger_moves,
           coalesce(st.amount, 0) AS items_start, coalesce(im.before, 0) AS items_moves_before,
           coalesce(im.amount, 0) AS items_moves,
           coalesce(nm.amount, 0) AS netsuite_moves, coalesce(bm.amount, 0) AS books_moves
    FROM (
      SELECT company_id, account_id FROM ledger_start
      UNION SELECT company_id, account_id FROM ledger_moves
      UNION SELECT company_id, account_id FROM items_start
      UNION SELECT company_id, account_id FROM items_moves
      UNION SELECT company_id, account_id FROM netsuite_moves
      UNION SELECT company_id, account_id FROM books_moves
    ) k
    LEFT JOIN ledger_start ls ON ls.company_id = k.company_id AND ls.account_id = k.account_id
    LEFT JOIN ledger_moves lm ON lm.company_id = k.company_id AND lm.account_id = k.account_id
    LEFT JOIN items_start st ON st.company_id = k.company_id AND st.account_id = k.account_id
    LEFT JOIN items_moves im ON im.company_id = k.company_id AND im.account_id = k.account_id
    LEFT JOIN netsuite_moves nm ON nm.company_id = k.company_id AND nm.account_id = k.account_id
    LEFT JOIN books_moves bm ON bm.company_id = k.company_id AND bm.account_id = k.account_id
  )
  SELECT jsonb_build_object(
    'month', to_char(p_month, 'YYYY-MM-DD'),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'company', c.code, 'item_id', r.item_id, 'location_id', r.location_id,
        'quantity', r.quantity::text, 'value', r.value::text
      ) ORDER BY r.item_id::bigint, r.location_id NULLS FIRST, c.code)
      FROM shown r
      JOIN public.gl_companies c ON c.id = r.company_id
    ), '[]'::jsonb),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'netsuite_id', i.netsuite_id, 'name', i.name, 'display_name', i.details->>'display_name', 'active', i.active
      ) ORDER BY i.netsuite_id::bigint)
      FROM public.gl_netsuite_lists i
      WHERE i.kind = 'item' AND i.netsuite_id IN (SELECT item_id FROM shown)
    ), '[]'::jsonb),
    'locations', coalesce((
      SELECT jsonb_agg(jsonb_build_object('netsuite_id', l.netsuite_id, 'name', l.name) ORDER BY l.name)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'location'
    ), '[]'::jsonb),
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
        'items_moves_before', p.items_moves_before::text,
        'items_moves', p.items_moves::text,
        'netsuite_moves', p.netsuite_moves::text,
        'books_moves', p.books_moves::text,
        'moves', (
          SELECT coalesce(jsonb_agg(jsonb_build_object('type', m.tran_type, 'documents', m.documents, 'total', m.total::text)
                                    ORDER BY abs(m.total) DESC, m.tran_type), '[]'::jsonb)
          FROM month_moves m
          WHERE m.company_id = p.company_id AND m.account_id = p.account_id
        ),
        'entries', (SELECT count(*) FROM ranked r WHERE r.company_id = p.company_id AND r.account_id = p.account_id),
        'entries_total', (
          SELECT coalesce(sum(r.amount), 0)::text FROM ranked r WHERE r.company_id = p.company_id AND r.account_id = p.account_id
        ),
        'month_entries', (
          SELECT count(*) FROM ranked r WHERE r.company_id = p.company_id AND r.account_id = p.account_id AND r.month = p_month
        ),
        'month_entries_total', (
          SELECT coalesce(sum(r.amount), 0)::text
          FROM ranked r
          WHERE r.company_id = p.company_id AND r.account_id = p.account_id AND r.month = p_month
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
            'month', to_char(r.month, 'YYYY-MM-DD'),
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
          WHERE r.company_id = p.company_id AND r.account_id = p.account_id AND r.n <= p_limit
        ),
        'usual', p.account_id IS NOT DISTINCT FROM (SELECT id FROM usual)
      ) ORDER BY c.code, a.number NULLS LAST, p.account_id)
      FROM parts p
      JOIN public.gl_companies c ON c.id = p.company_id
      LEFT JOIN public.gl_accounts a ON a.netsuite_account_id = p.account_id
      WHERE p.ledger_start <> 0 OR p.ledger_moves <> 0 OR p.items_start <> 0 OR p.items_moves <> 0
         OR p.netsuite_moves <> 0 OR p.books_moves <> 0
    ), '[]'::jsonb),
    'netsuite_through', coalesce((
      SELECT jsonb_agg(jsonb_build_object('company', c.code, 'month', to_char(x.month, 'YYYY-MM-DD')) ORDER BY c.code)
      FROM (SELECT company_id, max(month) AS month FROM public.gl_netsuite_month_totals GROUP BY company_id) x
      JOIN public.gl_companies c ON c.id = x.company_id
    ), '[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT := 'public.gl_stock_month_end(date, integer)';
  r TEXT;
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_stock_month_end(date, integer) IS 'Migration 495: inventory value at a month''s end (its first day, from January 2025): each company''s item at each location, its count and value then, each document counted in the month it posted to; and each inventory account then, the stocked items next to the GL copy, NetSuite''s own totals and FleetSuite''s books, with the month''s moves by kind and the documents with no stocked item (the month''s first, then the biggest, at most p_limit). Service role only.';
