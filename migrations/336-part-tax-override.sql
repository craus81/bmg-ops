-- Migration 336: which parts are taxed on a quote, owned by FleetSuite.
--
-- Since PR #984 every non-labor quote line was taxed, because NetSuite's item
-- Taxable box is not maintained in this account (see the note atop
-- src/lib/estimate-totals.ts). That taxed separately billed services such as
-- Graphics Install Labor, and freight, which Missouri does not tax when it is
-- its own line. Craig's call (2026-10-01): NetSuite Service items are untaxed
-- by default, freight is untaxed, and an admin can flip any single part.
--
-- netsuite_parts.taxable_override is FleetSuite's own answer and the parts
-- sync never writes it: NULL = follow the item type (Service = not taxed,
-- everything else taxed), true = always tax, false = never tax. It is NOT
-- netsuite_parts.is_taxable, which mirrors NetSuite's unmaintained box and
-- still drives nothing.
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS taxable_override BOOLEAN;

COMMENT ON COLUMN netsuite_parts.taxable_override IS
  'FleetSuite sales-tax setting. NULL = by item type (Service untaxed), true = always taxed, false = never taxed.';

-- The taxability each line was quoted with, snapshotted at save so a signed
-- quote, its NetSuite estimate/sales order and the invoice transformed from
-- it all agree even if the part's setting changes later. NULL (every line
-- saved before this migration) means taxed, which is how it was quoted.
ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS taxable BOOLEAN;

COMMENT ON COLUMN estimate_line_items.taxable IS
  'Sales tax applied to this line when last saved. NULL = taxed (saved before migration 336).';

-- Freight and shipping charges: untaxed when separately stated (RSMo 144.010
-- as amended 2017). Matched by exact item name, or an Other Charge item named
-- for freight/shipping, so a part like a Freightliner bracket is never caught.
-- Only fills a blank, so re-running never undoes an admin's choice.
UPDATE netsuite_parts
   SET taxable_override = false
 WHERE taxable_override IS NULL
   AND (
     upper(trim(item_number)) IN ('FREIGHT', 'FREIGHT IN', 'FREIGHT OUT', 'SHIPPING', 'SHIPPING & HANDLING', 'SHIPPING AND HANDLING', 'DELIVERY')
     OR (item_type = 'OthCharge' AND (item_number ILIKE '%freight%' OR item_number ILIKE '%shipping%'))
   );
