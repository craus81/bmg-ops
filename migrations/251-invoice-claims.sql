-- 251: atomic claims for the invoice/bill money paths (audit Stage 9 close,
-- Round 3 §7.2.4 / R3-8).
--
-- create-po's claim → 409 → release-on-failure → retire-in-success-stamp
-- shape (and convert-to-so's, migration 245) rolls onto the three invoice
-- writers that had only check-then-act guards — or none at all:
--   * /api/netsuite/create-invoice re-billed the same installed units on
--     every POST (no check of any kind);
--   * /api/graphics/create-invoice had a truthy guard two concurrent
--     clicks could both pass before either stamped;
--   * /api/parts-mail/create-bill's 409 was check-then-act and its billed
--     stamp was unchecked.
-- A claim column per table, nullable, no backfill — the routes treat a
-- missing column gracefully (PostgREST schema-cache lag, the #741 lesson),
-- so this migration deploying in the same build as the code is safe in
-- either order.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS invoice_claimed_at TIMESTAMPTZ;
COMMENT ON COLUMN purchase_orders.invoice_claimed_at IS
  'Migration 251: atomic claim for /api/netsuite/create-invoice. Non-null while an invoice create for this PO''s SO is in flight; stale claims (>15min) are taken over. Cleared by the success stamp or the failure release.';

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS invoice_claimed_at TIMESTAMPTZ;
COMMENT ON COLUMN graphics_jobs.invoice_claimed_at IS
  'Migration 251: atomic claim for /api/graphics/create-invoice. Same shape as purchase_orders.invoice_claimed_at.';

ALTER TABLE vendor_parts_invoices
  ADD COLUMN IF NOT EXISTS bill_claimed_at TIMESTAMPTZ;
COMMENT ON COLUMN vendor_parts_invoices.bill_claimed_at IS
  'Migration 251: atomic claim for /api/parts-mail/create-bill. Same shape as purchase_orders.invoice_claimed_at.';
