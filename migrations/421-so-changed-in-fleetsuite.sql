-- Migration 421: note on the estimate when its sales order is edited on the
-- FleetSuite sales order page (src/lib/sales-order-edit.ts, 2026-10-21).
--
-- Craig: open and edit sales orders natively in FleetSuite. The estimate is
-- the customer-approved document, so an order edit does NOT rewrite it; the
-- estimate's sales order bar says the order was changed, when and by whom,
-- so nobody pushes the estimate's old lines back over the edit unaware.

ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS so_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS so_changed_by TEXT;

COMMENT ON COLUMN public.estimates.so_changed_at IS
  'Last time the linked NetSuite sales order was edited on the FleetSuite sales order page. NULL = never. Cleared by a successful Push changes to SO.';
COMMENT ON COLUMN public.estimates.so_changed_by IS
  'Name of the person who made that sales order edit.';
