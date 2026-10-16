-- Migration 385: FleetSuite's own books, part 11 — vendor bills, the bill
-- rule's first fixes.
--
-- Owner decision 2026-10-16 ("Fix both", thread "Replacing NetSuite with
-- FleetSuite"), after the first check of the bills copy (migration 384):
-- a discount on a bill is booked on its own line at its own amount while
-- the other lines go in at theirs, and received stock is decided line by
-- line, from the purchase order line each bill line came from. The copy
-- (src/lib/books/netsuite-bills.ts) now keeps each line's own amount and the
-- lines each link is on, inside the JSON it already stores, so the table
-- doesn't change; the column comments below say what's in it now.
--
-- gl_bill_item_accounts: for the items the copy of NetSuite's items has no
-- account for (a discount item, say: NetSuite keeps its account where the
-- items copy doesn't read it), the accounts NetSuite's GL (migration 361)
-- posted their lines on the copied bills to, so the bill rule can go where
-- NetSuite goes, as the invoice rule does for an item with no income
-- account. Read-only; the service role only.

CREATE OR REPLACE FUNCTION public.gl_bill_item_accounts(p_items TEXT[])
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('item', u.item, 'account', u.account, 'lines', u.lines)
                            ORDER BY u.item, u.lines DESC, u.account), '[]'::jsonb)
  FROM (
    SELECT l.line->>'item' AS item, g.netsuite_account_id AS account, count(*) AS lines
    FROM public.gl_netsuite_bills b
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(b.lines, '[]'::jsonb)) AS l(line)
    JOIN public.gl_netsuite_lines g ON g.transaction_id = b.netsuite_id AND g.line_id = l.line->>'line_id'
    WHERE b.gone_at IS NULL
      AND l.line->>'item' = ANY (coalesce(p_items, '{}'::text[]))
    GROUP BY 1, 2
  ) u
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT := 'public.gl_bill_item_accounts(text[])';
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

COMMENT ON FUNCTION public.gl_bill_item_accounts(text[]) IS 'Migration 385: for each of the given NetSuite item ids, the accounts NetSuite''s GL (migration 361) posted the item''s lines on the copied bills and bill credits to, with how many lines: [{item, account, lines}], most used first. Where the bill rule posts an item the copy of NetSuite''s items has no account for. Service role only.';
COMMENT ON COLUMN gl_netsuite_bills.lines IS 'Its lines but the payables line, from NetSuite''s transaction lines: [{line_id, item, account, amount, own_amount, quantity, memo, tax}]. item is the item''s NetSuite id (null on an expense line), account the line''s expense account when NetSuite gives one, amount its net amount (netamount, a discount line''s amount shared out over the lines above it) and own_amount its own (foreignamount), both signed as NetSuite gives them; rows copied before migration 385 have no own_amount. NULL until a run could read them.';
COMMENT ON COLUMN gl_netsuite_bills.links IS 'The documents it came from, from NetSuite''s transaction link table (its previous documents): a bill''s purchase orders and item receipts, a bill credit''s vendor return. [{netsuite_id, type, number, amount, link_type, lines}], amounts positive; lines are the document''s own line ids the link is on, left out when the run couldn''t read them line by line. NULL until a run could read them.';
