-- Migration 247: the one NetSuite item estimates and sales orders bill shop
-- labor to.
--
-- Labor stopped reaching NetSuite when the resolver was narrowed to items
-- named exactly LABOR / LABOR%: this account has none, so every push landed
-- short by the whole labor amount with only a console.warn. The code-side
-- search is wider and ranked again, but the durable answer is that an admin
-- names the item once, here (Settings -> NetSuite Labor Item), and every
-- estimate bills the same GL account forever after.
--
-- Nullable on purpose: unset = fall back to the ranked NetSuite search.
-- Both columns are plain admin-writable settings (the migration-245 trigger
-- guards only sales_tax_rate_pct).

ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS netsuite_labor_item_id TEXT;
ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS netsuite_labor_item_number TEXT;

COMMENT ON COLUMN quote_settings.netsuite_labor_item_id IS
  'NetSuite INTERNAL id of the labor item estimates/SOs bill labor to. Null = resolve by search.';
COMMENT ON COLUMN quote_settings.netsuite_labor_item_number IS
  'That item''s NetSuite name (itemid), stored for display only.';

INSERT INTO quote_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
