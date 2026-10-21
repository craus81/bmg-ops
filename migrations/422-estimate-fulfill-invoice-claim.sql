-- Migration 422: a claim for the estimate's Fulfill & Invoice.
--
-- Fulfill & Invoice (thread "Creating invoices from FleetSuite", 2026-10-21)
-- ships and bills an estimate's sales order from the estimate. A double
-- click, or two people at once, must not make two fulfillments and two
-- invoices: the route claims the estimate first (the create-invoice shape,
-- migration 251), and a claim older than 15 minutes is taken over.

ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS fulfill_invoice_claimed_at TIMESTAMPTZ;
