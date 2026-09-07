-- Migration 262: atomic claim for the estimate → NetSuite push (§7.4 item 1)
--
-- The push route decided create-vs-update from one stale read and wrote its
-- NetSuite id back fire-and-forget: two concurrent pushes (or a push whose
-- stamp silently failed, followed by a retry) both took the CREATE branch
-- and minted two real NetSuite estimates. Same claim discipline as the
-- conversion claim (245), the invoice claims (251), and the promotion claim
-- (254): claim → NetSuite call → checked stamp retires the claim; release
-- on failure; a claim older than 15 minutes is stale and reclaimable.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS push_claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN estimates.push_claimed_at IS
  'Migration 262: atomic push claim — stamped before the NetSuite estimate create/update, retired by the checked write-back, released on failure. A claim older than 15 minutes is stale and reclaimable.';
