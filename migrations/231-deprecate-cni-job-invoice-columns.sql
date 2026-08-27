-- Migration 231: deprecate the legacy per-job CNI invoice columns IN PLACE
--
-- The legacy company-mode invoice flow (installer uploads a file onto the
-- job, coordinator approves it, a NetSuite bill id is typed back onto the
-- job) is removed from the app: company billing now runs exclusively through
-- the AP flow (vendor_invoices / vendor_invoice_lines), and the closure
-- checklist reads AP coverage (plus a grandfather clause for jobs approved
-- under this legacy flow). See docs/workflow-audit-2026-08.md, Part 5
-- item 14.
--
-- The columns are NOT dropped: historical closed jobs still render their
-- legacy invoice line read-only, the closure grandfather reads
-- invoice_status, and audit-diff history references the old values. A real
-- drop can ride a later cleanup once no open job predates the cutover.

COMMENT ON COLUMN cni_jobs.invoice_status IS
  'DEPRECATED (2026-08): legacy per-job company invoice flow, removed from the app. Read-only historical data — company billing lives in vendor_invoices now; do not write.';
COMMENT ON COLUMN cni_jobs.invoice_file_path IS
  'DEPRECATED (2026-08): legacy per-job company invoice flow, removed from the app. Read-only historical data; do not write.';
COMMENT ON COLUMN cni_jobs.invoice_approved_at IS
  'DEPRECATED (2026-08): legacy per-job company invoice flow, removed from the app. Read-only historical data; do not write.';
COMMENT ON COLUMN cni_jobs.invoice_approved_by IS
  'DEPRECATED (2026-08): legacy per-job company invoice flow, removed from the app. Read-only historical data; do not write.';
COMMENT ON COLUMN cni_jobs.netsuite_bill_id IS
  'DEPRECATED (2026-08): legacy per-job company invoice flow, removed from the app. Read-only historical data — bills live on vendor_invoices.netsuite_bill_id (company AP) and payouts.netsuite_bill_id (individual mode); do not write.';
