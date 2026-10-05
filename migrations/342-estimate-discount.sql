-- Migration 342: a discount on estimates, and the NetSuite item it bills to.
--
-- Craig (2026-10-05) asked for a discount button on estimates. The rep types
-- a percent or a dollar amount; it comes off the WHOLE job (parts + labor)
-- before tax. It reaches NetSuite as a discount line on the estimate and the
-- sales order: the share of it that sits on taxed parts goes as a taxed line
-- (so NetSuite lowers the tax the same way FleetSuite does), the rest as an
-- untaxed line. See discountSplit in src/lib/estimate-totals.ts.
--
-- discount_type / discount_value are what the rep typed; discount_amount is
-- the dollars it came to, stored like the other totals so lists, reports and
-- documents read it without recomputing. grand_total already nets it out.
-- discount_amount is NOT NULL DEFAULT 0, so every existing estimate reads as
-- undiscounted and its totals are unchanged.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_type TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2);
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'estimates_discount_type_check'
  ) THEN
    ALTER TABLE estimates ADD CONSTRAINT estimates_discount_type_check
      CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount'));
  END IF;
END $$;

COMMENT ON COLUMN estimates.discount_type IS
  'percent | amount | NULL (no discount). Off the whole job, before tax (migration 342).';
COMMENT ON COLUMN estimates.discount_value IS
  'What the rep typed: the percent (10 = 10%) or the dollar amount.';
COMMENT ON COLUMN estimates.discount_amount IS
  'Dollars the discount came to. grand_total = subtotal + labor_total - discount_amount + tax_amount.';

-- The NetSuite item discount lines bill to (Settings -> NetSuite Discount
-- Item), the same shape as the labor item (migration 247). Unset = the push
-- looks for an active Discount-type item itself.
ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS netsuite_discount_item_id TEXT;
ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS netsuite_discount_item_number TEXT;

COMMENT ON COLUMN quote_settings.netsuite_discount_item_id IS
  'NetSuite INTERNAL id of the item estimate discounts push as. Null = resolve by search.';
COMMENT ON COLUMN quote_settings.netsuite_discount_item_number IS
  'That item''s NetSuite name (itemid), stored for display only.';

INSERT INTO quote_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
