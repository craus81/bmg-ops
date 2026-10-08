-- Migration 350: a discount on one estimate line.
--
-- Craig (2026-10-06): "a discount per part as well... if we only want to
-- discount one thing in the order", and he chose a discount LINE over a
-- lower price: the quote shows the part at full price with a discount row
-- under it, and the push sends a NetSuite discount line right below that
-- part (NetSuite applies a discount line to the line above it). The tax on
-- it follows the part's own taxability. See lineMoney in
-- src/lib/estimate-totals.ts and buildLineDiscountLine in
-- src/lib/discount-item.ts. The whole-estimate discount is migration 342.
--
-- discount_type / discount_value are what the rep typed (a percent of the
-- line, or dollars off the line's whole amount across all vehicles);
-- discount_amount is the dollars it came to, stored for documents.
-- discount_amount is NOT NULL DEFAULT 0, so every existing line reads as
-- undiscounted.

ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS discount_type TEXT;
ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2);
ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'estimate_line_items_discount_type_check'
  ) THEN
    ALTER TABLE estimate_line_items ADD CONSTRAINT estimate_line_items_discount_type_check
      CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount'));
  END IF;
END $$;

COMMENT ON COLUMN estimate_line_items.discount_type IS
  'percent | amount | NULL (no discount) on this line (migration 350).';
COMMENT ON COLUMN estimate_line_items.discount_value IS
  'What the rep typed: the percent (10 = 10%) or dollars off the whole line (all vehicles).';
COMMENT ON COLUMN estimate_line_items.discount_amount IS
  'Dollars the line discount came to. estimates.subtotal is net of these.';
