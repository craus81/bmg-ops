-- Add invoice tracking fields to fleet_checkins for archived vehicle billing
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS date_invoiced DATE;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false;

-- Add invoice tracking fields to scan_logs for archived scan billing
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS date_invoiced DATE;
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false;
