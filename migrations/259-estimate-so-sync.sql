-- Does the NetSuite sales order still match its estimate?
--
-- An admin can edit a customer-accepted estimate with a recorded reason,
-- but nothing then touched the sales order already created from it — the
-- SO silently kept the old lines and money. Owner decision (2026-09-03):
-- prompt to push the changes, never update the SO silently.
--
-- so_pushed_hash is the SO "contract" as last pushed (lines with quantity
-- > 0: item, qty, price; labor hours + rate; PO/reference number; VIN —
-- src/lib/so-sync.ts). The save route compares the estimate against it
-- and flips so_out_of_date; a successful push (convert-to-so, or the new
-- push-so route) stamps the fresh hash and clears the flag.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS so_pushed_hash TEXT,
  ADD COLUMN IF NOT EXISTS so_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS so_out_of_date BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN estimates.so_pushed_hash IS
  'sha256 of the sales-order contract (lines/labor/PO/VIN) as last pushed to NetSuite — src/lib/so-sync.ts soContentHash(). NULL on estimates converted before migration 259: treated as unknown (the builder offers the push with softer wording).';
COMMENT ON COLUMN estimates.so_synced_at IS
  'When the NetSuite sales order last received this estimate''s lines (conversion or push-so).';
COMMENT ON COLUMN estimates.so_out_of_date IS
  'True once an estimate with a sales order is saved with content that no longer matches so_pushed_hash. Cleared by a successful push-so. The builder shows "Sales order is out of date — Push changes".';
