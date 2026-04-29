-- Migration 072: Link graphics production jobs to estimates and invoices
-- Allows PO-based jobs to go straight to invoice (skip sales order)
-- Allows non-PO jobs to have an estimate that travels with the job to completion

-- ═══════════ GRAPHICS JOBS: Estimate & Invoice Fields ═══════════

-- Link to local estimate (for non-PO jobs that start as estimates)
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL;

-- PO number field (for PO-based jobs — carries through to invoice)
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS po_number TEXT;

-- NetSuite customer reference (for direct invoicing)
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS customer_netsuite_id TEXT;

-- Direct invoice tracking (skip SO, go straight PO → Invoice)
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS netsuite_invoice_id TEXT;
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS netsuite_invoice_number TEXT;
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ;
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS invoiced_by UUID REFERENCES auth.users(id);

-- Invoice amount tracking
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS invoice_amount NUMERIC(12,2);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_graphics_jobs_estimate ON graphics_jobs(estimate_id);
CREATE INDEX IF NOT EXISTS idx_graphics_jobs_po_number ON graphics_jobs(po_number);
CREATE INDEX IF NOT EXISTS idx_graphics_jobs_invoice ON graphics_jobs(netsuite_invoice_id);
