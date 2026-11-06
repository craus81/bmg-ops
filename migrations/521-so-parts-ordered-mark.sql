-- Migration 521: "Parts ordered" by hand on a sales order.
--
-- Craig, 2026-11-06 (thread "Mark sales orders parts ordered"): a sales
-- order turns green on the Sales orders list once every part line is on a
-- vendor PO or covered by stock nobody else is holding (src/lib/so-parts-cover.ts,
-- worked out on the fly, nothing stored). Because the stock numbers aren't
-- fully trusted yet, an admin can also mark an order "Parts ordered" by
-- hand. The mark remembers which parts the order had, so it stops counting
-- by itself once a part is added to the order.

ALTER TABLE netsuite_sales_orders ADD COLUMN IF NOT EXISTS parts_marked_at TIMESTAMPTZ;
ALTER TABLE netsuite_sales_orders ADD COLUMN IF NOT EXISTS parts_marked_by UUID;
ALTER TABLE netsuite_sales_orders ADD COLUMN IF NOT EXISTS parts_marked_by_name TEXT;
ALTER TABLE netsuite_sales_orders ADD COLUMN IF NOT EXISTS parts_marked_items TEXT[];

COMMENT ON COLUMN netsuite_sales_orders.parts_marked_at IS
  'An admin marked this order "Parts ordered" by hand (migration 521). Counts only while the order has no part outside parts_marked_items.';
COMMENT ON COLUMN netsuite_sales_orders.parts_marked_items IS
  'Part numbers on the order when it was marked by hand; a part added later voids the mark.';
