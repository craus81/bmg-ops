-- Migration 403: stock by item names the items NetSuite keeps in stock whose
-- asset account isn't an asset account (owner decision 2026-10-19, thread
-- "Replacing NetSuite with FleetSuite", "Flag them").
--
-- After migration 402, two items' values on the real books still stood apart
-- from NetSuite's. In NetSuite each had its asset account and its cost of
-- goods sold account swapped: their receipts put what they cost on the cost
-- of goods sold account instead of inventory, and each shipment put it into
-- inventory instead of taking it out. So NetSuite's ledger held value on
-- items none were left of, and its own stock report didn't show it, as it
-- values what's on hand at the average cost.
--
-- FleetSuite can't read an item's cost of goods sold account (NetSuite
-- answers 500 for it, so the lists copy of migration 363 leaves it out), but
-- it reads the asset account, which is wrong in a swap. gl_stock_item_setup
-- lists each active item NetSuite keeps in stock (InvtPart or Assembly, as
-- bill-rule.ts STOCK_TYPES) whose asset account the chart of accounts has as
-- anything but an asset account, with that account, and the asset account
-- most stocked items use, so Stock by item can say what to set it to. An
-- item drops off once NetSuite has it right and the lists copy (every two
-- hours, or Sync now on NetSuite lists) has read it again.
--
-- Reads only. Service role only, as the rest of stock by item.
-- docs/books.md "Stock by item".

CREATE OR REPLACE FUNCTION public.gl_stock_item_setup()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH stocked AS (
    SELECT i.netsuite_id, i.name, i.details->>'display_name' AS display_name,
           a.netsuite_account_id AS account_id, a.number, a.name AS account_name, a.account_type,
           a.account_type IN ('other_current_asset', 'fixed_asset', 'other_asset') AS is_asset
    FROM public.gl_netsuite_lists i
    JOIN public.gl_accounts a ON a.netsuite_account_id = i.details->>'asset_account'
    WHERE i.kind = 'item' AND i.active AND i.gone_at IS NULL
      AND i.details->>'item_type' IN ('InvtPart', 'Assembly')
  ),
  usual AS (
    SELECT account_id, number, account_name
    FROM stocked
    WHERE is_asset
    GROUP BY account_id, number, account_name
    ORDER BY count(*) DESC, number NULLS LAST, account_id
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'netsuite_id', s.netsuite_id, 'name', s.name, 'display_name', s.display_name,
        'account', jsonb_build_object('netsuite_id', s.account_id, 'number', s.number, 'name', s.account_name, 'type', s.account_type)
      ) ORDER BY s.name, s.netsuite_id)
      FROM stocked s
      WHERE NOT s.is_asset
    ), '[]'::jsonb),
    'usual', (SELECT jsonb_build_object('netsuite_id', u.account_id, 'number', u.number, 'name', u.account_name) FROM usual u)
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.gl_stock_item_setup() FROM PUBLIC;
DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_stock_item_setup() FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gl_stock_item_setup() TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_stock_item_setup() IS 'Migration 403: the active items NetSuite keeps in stock (InvtPart, Assembly) whose asset account the chart of accounts has as anything but an asset account, with that account, and the asset account most stocked items use. Service role only.';
