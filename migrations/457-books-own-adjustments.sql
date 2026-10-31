-- Migration 457: FleetSuite's own books, part 31 — Own adjustments.
--
-- Owner decision 2026-10-30 (thread "Replacing NetSuite with FleetSuite",
-- "Own postings", then "Build it", its second piece): Books checks each
-- Inventory Adjust (migration 454, src/lib/inventory-adjust.ts) against
-- NetSuite's inventory adjustment, valuing the change at FleetSuite's own
-- average cost of the item at the location just before, and the books post
-- it in place of NetSuite's adjustment when it matches and its entry comes
-- out the same, as they post FleetSuite's own fulfillments and receipts
-- (migration 456, src/lib/books/own-stock-posting.ts): own_adjustment@1,
-- keyed `inventory_adjustment:<NetSuite id>:<n>` as NetSuite's is, so
-- nothing else that reads the books changes.
--
-- Books keeps no copy of its own: the Inventory Adjust history
-- (inventory_adjustments, a row each, saved when NetSuite took it) is
-- FleetSuite's record of each one. Inventory Adjust is BMG's: it adjusts
-- O'Fallon's stock. This adds two reads:
--   * gl_own_adjustment_pairs(from, to, id, account), the Inventory Adjusts
--     made on those days in Central time, or only the one, each next to
--     NetSuite's adjustment as the copy of its stock moves has it (migration
--     401), each line valued from the copy of its general ledger (migration
--     361), what NetSuite's adjustment posted to each account, the count and
--     value FleetSuite had of the item at the location just before, as stock
--     by item counts and values them (migrations 401 and 402), and the names
--     the pages show, with the account numbered `account` (the one Inventory
--     Adjust posts to, 52000 Inventory Adjustment);
--   * gl_own_adjustment_months(), how many were made each month.
-- No table is added or changed.
--
-- Caller: the service role only, from the posting job, the daily check and
-- the super admin pages' APIs.

-- The Inventory Adjusts made from p_from to p_to (Central time), or only the one whose id is p_id, newest first, each
-- next to NetSuite's adjustment:
--   adjustments: [{ own: the Inventory Adjust: { id, item_id, item_number, location_id, mode, entered_qty, change,
--                        on_hand_before, reason, note, netsuite_id (null unless NetSuite's id for it is a number),
--                        number, made_by, date (the day it was made, Central time), made_at },
--                   netsuite: NetSuite's adjustment as the copy of its stock moves has it, with each line that names
--                             an item: its company, location, quantity (signed, stock in positive), whether it moves
--                             stock, and its value, what NetSuite posted to an inventory account on it in the copy of
--                             its general ledger (debit positive; null when that copy has nothing on the line); null
--                             before the stock copy has it,
--                   netsuite_gl: { posting_month, entry: what it posted to each of BMG's accounts, each saying whether
--                                  it's an inventory account } once the copy of NetSuite's general ledger has it, else
--                                null,
--                   before: { quantity, value } what FleetSuite counted of the item at the location just before: its
--                           count and value on December 31, 2024 and every document since that comes before it, by
--                           date and then NetSuite's id (every one dated before it when NetSuite's id isn't known);
--                           null when the Inventory Adjust names no location }]
--   items:     { <NetSuite item id>: { number, type, display_name, asset_account } } for the items on either side
--   locations: { <NetSuite location id>: name }
--   accounts:  { <NetSuite account id>: { number, name } } for the accounts NetSuite's adjustments posted to
--   account:   { id, number, name } the chart's account numbered p_account; null when it has none
-- Quantities and amounts are decimal strings.
CREATE OR REPLACE FUNCTION public.gl_own_adjustment_pairs(p_from DATE, p_to DATE, p_id UUID, p_account TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = 'BMG'
  ),
  own AS (
    SELECT a.*,
           (a.created_at AT TIME ZONE 'America/Chicago')::date AS made_on,
           CASE WHEN a.netsuite_adjustment_id ~ '^[0-9]+$' THEN a.netsuite_adjustment_id END AS ns_id
    FROM public.inventory_adjustments a
    WHERE CASE WHEN p_id IS NOT NULL THEN a.id = p_id
               ELSE (a.created_at AT TIME ZONE 'America/Chicago')::date BETWEEN p_from AND p_to END
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
    SELECT o.id AS own_id, d.*
    FROM own o
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = o.ns_id
  ),
  twin_lines AS (
    SELECT t.own_id, s.line_id, c.code AS company, s.item_id, s.location_id, s.quantity, s.moves_stock,
           (SELECT sum(l.debit - l.credit)
            FROM public.gl_netsuite_lines l
            WHERE l.transaction_id = s.document_id AND l.line_id = s.line_id
              AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)) AS value
    FROM twin t
    JOIN public.gl_netsuite_stock_lines s ON s.document_id = t.netsuite_id
    JOIN public.gl_companies c ON c.id = s.company_id
  ),
  before AS (
    SELECT o.id AS own_id,
           coalesce(op.quantity, 0) + coalesce(mv.quantity, 0) AS quantity,
           CASE WHEN o.netsuite_item_id IN (SELECT item_id FROM stocked) THEN coalesce(op.value, 0) + coalesce(vl.value, 0) ELSE 0 END AS value
    FROM own o
    LEFT JOIN public.gl_netsuite_stock_opening op
      ON op.company_id = (SELECT id FROM company) AND op.item_id = o.netsuite_item_id AND op.location_id IS NOT DISTINCT FROM o.location_id
    LEFT JOIN LATERAL (
      SELECT sum(s.quantity) AS quantity
      FROM public.gl_netsuite_stock_lines s
      JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
      WHERE s.item_id = o.netsuite_item_id AND s.company_id = (SELECT id FROM company) AND s.location_id IS NOT DISTINCT FROM o.location_id
        AND s.moves_stock AND d.gone_at IS NULL
        AND (d.trandate, d.netsuite_id::bigint) < (o.made_on, coalesce(o.ns_id, '0')::bigint)
    ) mv ON true
    LEFT JOIN LATERAL (
      SELECT sum(l.debit - l.credit) AS value
      FROM public.gl_netsuite_stock_lines s
      JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
      JOIN public.gl_netsuite_lines l ON l.transaction_id = s.document_id AND l.line_id = s.line_id
      WHERE s.item_id = o.netsuite_item_id AND s.company_id = (SELECT id FROM company) AND s.location_id IS NOT DISTINCT FROM o.location_id
        AND d.gone_at IS NULL
        AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)
        AND (d.trandate, d.netsuite_id::bigint) < (o.made_on, coalesce(o.ns_id, '0')::bigint)
    ) vl ON true
    WHERE o.location_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'adjustments', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'id', o.id,
          'item_id', o.netsuite_item_id,
          'item_number', o.item_number,
          'location_id', o.location_id,
          'mode', o.mode,
          'entered_qty', o.entered_qty::text,
          'change', o.change::text,
          'on_hand_before', o.on_hand_before::text,
          'reason', o.reason,
          'note', o.note,
          'netsuite_id', o.ns_id,
          'number', o.netsuite_adjustment_number,
          'made_by', o.created_by_name,
          'date', to_char(o.made_on, 'YYYY-MM-DD'),
          'made_at', o.created_at
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
                'company', tl.company,
                'item_id', tl.item_id,
                'location_id', tl.location_id,
                'quantity', tl.quantity::text,
                'moves_stock', tl.moves_stock,
                'value', tl.value::text
              ) ORDER BY tl.line_id::bigint), '[]'::jsonb)
              FROM twin_lines tl
              WHERE tl.own_id = o.id
            )
          )
          FROM twin t
          WHERE t.own_id = o.id
        ),
        'netsuite_gl', (
          SELECT jsonb_build_object(
            'posting_month', to_char(g.posting_month, 'YYYY-MM-DD'),
            'entry', (
              SELECT coalesce(jsonb_agg(jsonb_build_object(
                'account_id', e.account_id, 'debit', e.debit::text, 'credit', e.credit::text,
                'inventory', e.account_id IN (SELECT id FROM asset_accounts)
              ) ORDER BY e.account_id::bigint), '[]'::jsonb)
              FROM (
                SELECT l.netsuite_account_id AS account_id, sum(l.debit) AS debit, sum(l.credit) AS credit
                FROM public.gl_netsuite_lines l
                WHERE l.transaction_id = o.ns_id AND l.company_id = (SELECT id FROM company)
                GROUP BY l.netsuite_account_id
              ) e
            )
          )
          FROM public.gl_netsuite_transactions g
          WHERE g.netsuite_id = o.ns_id
        ),
        'before', (
          SELECT jsonb_build_object('quantity', b.quantity::text, 'value', b.value::text)
          FROM before b
          WHERE b.own_id = o.id
        )
      ) ORDER BY o.created_at DESC, o.id), '[]'::jsonb)
      FROM own o
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object(
        'number', l.name, 'type', l.details->>'item_type', 'display_name', l.details->>'display_name',
        'asset_account', CASE WHEN l.details->>'asset_account' ~ '^[0-9]+$' THEN l.details->>'asset_account' END
      )), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'item' AND l.netsuite_id IN (
        SELECT o.netsuite_item_id FROM own o
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
        SELECT l.netsuite_account_id FROM public.gl_netsuite_lines l JOIN own o ON o.ns_id = l.transaction_id
      )
    ),
    'account', (
      SELECT jsonb_build_object('id', a.netsuite_account_id, 'number', a.number, 'name', a.name)
      FROM public.gl_accounts a
      WHERE a.number = p_account AND a.netsuite_account_id IS NOT NULL
      ORDER BY a.active DESC, a.netsuite_account_id
      LIMIT 1
    )
  )
$$;

-- How many Inventory Adjusts were made each month (Central time), newest first: [{ month: 'YYYY-MM-01', adjustments }].
CREATE OR REPLACE FUNCTION public.gl_own_adjustment_months()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM-DD'), 'adjustments', m.adjustments)
                            ORDER BY m.month DESC), '[]'::jsonb)
  FROM (
    SELECT date_trunc('month', (created_at AT TIME ZONE 'America/Chicago')::date)::date AS month, count(*) AS adjustments
    FROM public.inventory_adjustments
    GROUP BY 1
  ) m
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.gl_own_adjustment_pairs(date, date, uuid, text)',
    'public.gl_own_adjustment_months()'
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

COMMENT ON FUNCTION public.gl_own_adjustment_pairs(date, date, uuid, text) IS 'Migration 457: the Inventory Adjusts made on some days (Central time), or one, each next to NetSuite''s adjustment as the copies of its stock moves and general ledger have it, with FleetSuite''s count and value of the item at the location just before it, for Own adjustments, the posting job and the daily check (src/lib/books/own-adjustment-check.ts). Service role only.';
COMMENT ON FUNCTION public.gl_own_adjustment_months() IS 'Migration 457: how many Inventory Adjusts were made each month, Central time. Service role only.';
