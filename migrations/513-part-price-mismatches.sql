-- Migration 513: parts whose selling price in FleetSuite and NetSuite differ.
--
-- Owner ask (Craig, 2026-11-03): prices must be the same in both. FleetSuite
-- is where prices change (Admin → Update Prices uploads them and sends each
-- one to NetSuite), but a price changed in NetSuite never comes back, and a
-- price NetSuite refused stays different. The nightly check
-- (/api/cron/price-mismatch-check, src/lib/price-mismatch.ts) compares every
-- part's FleetSuite price with NetSuite's base price and keeps one row here
-- per part that differs, so Update Prices → "Prices that don't match" can
-- send FleetSuite's price to NetSuite or take NetSuite's.
--
--   * fleetsuite_price / netsuite_price: what each had at the last look
--     (netsuite_price null = NetSuite has no price);
--   * reason: why, when FleetSuite knows (an upload NetSuite refused);
--   * first_seen_at: when it was first found, so the nightly alert only
--     names new ones; checked_at: the last look.
--
-- Writer and reader: the service role only (no policies).

CREATE TABLE IF NOT EXISTS part_price_mismatches (
  part_id UUID PRIMARY KEY REFERENCES netsuite_parts(id) ON DELETE CASCADE,
  item_number TEXT NOT NULL,
  fleetsuite_price NUMERIC(12,2),
  netsuite_price NUMERIC(12,2),
  reason TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS part_price_mismatches_item_number ON part_price_mismatches (item_number);

ALTER TABLE part_price_mismatches ENABLE ROW LEVEL SECURITY;
