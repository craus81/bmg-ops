-- Migration 451: a Stock # beside the Unit # on estimates and scans.
--
-- Craig (2026-10-28, thread "Add separate unit and stock number fields"):
-- the estimate's one "Unit/Stock #" box becomes two. Unit # stays in
-- unit_number (existing values are left there); the dealer's stock number
-- gets its own column and goes everywhere the unit already goes: the
-- estimate PDF and approval page, the NetSuite SO memo, graphics jobs and
-- fleet kits, the Shop arriving board, invoice vehicle lines, search,
-- scans and vehicle history.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS stock_number TEXT;
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS stock_number TEXT;

COMMENT ON COLUMN estimates.stock_number IS
  'Dealer/customer stock number for the vehicle (separate from unit_number). Shown on the estimate document and carried into the SO memo.';
COMMENT ON COLUMN scan_logs.stock_number IS
  'Stock number for the scanned vehicle, logged alongside the VIN and unit number.';
