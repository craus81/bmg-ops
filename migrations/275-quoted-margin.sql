-- 275: Quoted-margin freeze at send (R5-3, Tier 2 margin-ledger item —
-- the capture + governance half; the report is R5-10).
--
-- The estimate builder computes per-line true cost, margin %, and floor
-- breaches live on screen, then throws them away — estimate_line_items
-- stores no cost, so "what margin did we quote this month" was
-- unanswerable and the floor purely advisory.
--
-- The snapshot lives on the HEADER, not the lines: the estimate save path
-- deletes and re-inserts every line (estimates/route.ts), so line-level
-- frozen values would be wiped on the next edit. Frozen by the ONE send
-- route (send-for-approval) at the moment of send; a RE-SEND overwrites —
-- each send is a new offer, and the snapshot always describes the version
-- the customer last received. Lines edited after send without a re-send
-- deliberately leave the snapshot at the last-sent state.
--
-- Scope: estimates only (wrap quotes have a different cost model — their
-- freeze is future work, per the audit's "honest M" scoping).
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS quoted_cost_total NUMERIC(14,2);
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS quoted_margin_pct NUMERIC(6,2);
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS quoted_below_floor BOOLEAN;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS quoted_floor_pct NUMERIC(5,2);
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS quoted_labor_cost NUMERIC(12,2);
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS quoted_margin_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS below_floor_reason TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS quoted_margin_detail JSONB;

COMMENT ON COLUMN estimates.quoted_margin_pct IS
  'Parts margin % frozen at the last send (costed lines only; NULL = no costed lines). Matches the builder''s live "Parts Margin" formula exactly.';
COMMENT ON COLUMN estimates.quoted_labor_cost IS
  'Sold labor hours x quote_settings.shop_labor_cost_rate at send; NULL = no blended rate configured (margin shows parts only).';
COMMENT ON COLUMN estimates.below_floor_reason IS
  'Typed by the sender when quoted_margin_pct was below the floor at send — required, audit-logged, owner-notified.';
COMMENT ON COLUMN estimates.quoted_margin_detail IS
  'Per-line frozen snapshot: [{item_number, quantity, unit_price, unit_cost, margin_pct}] — unit_cost NULL = uncosted (custom/no-cost part), never treated as 100% margin.';

CREATE INDEX IF NOT EXISTS idx_estimates_quoted_margin_at
  ON estimates(quoted_margin_at) WHERE quoted_margin_at IS NOT NULL;
