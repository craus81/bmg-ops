-- Migration 082: Track NetSuite invoice on graphics_jobs
--
-- Graphics ship-out → admin "create invoice in FleetSuite?" prompt creates
-- a standalone NetSuite invoice (no SO required). Once created, store the
-- invoice id/number on the graphics job so we don't double-prompt and so
-- the UI can surface "already invoiced" state.

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS netsuite_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS netsuite_invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ;
