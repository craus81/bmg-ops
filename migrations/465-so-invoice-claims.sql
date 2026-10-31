-- Migration 465: one Fulfill & Invoice at a time per sales order.
--
-- Fulfill & Invoice moved onto the sales order page (thread "Invoice from
-- the sales order page", 2026-10-31), so it now runs for orders typed
-- straight into NetSuite that have no estimate to hold the claim (migration
-- 422). Both buttons, the estimate's and the sales order page's, claim the
-- sales order here instead; a claim older than 15 minutes is taken over.
-- estimates.fulfill_invoice_claimed_at is no longer written.

CREATE TABLE IF NOT EXISTS public.so_invoice_claims (
  so_netsuite_id TEXT PRIMARY KEY,
  claimed_at TIMESTAMPTZ
);

-- Server routes only (service role); no staff policies.
ALTER TABLE public.so_invoice_claims ENABLE ROW LEVEL SECURITY;
