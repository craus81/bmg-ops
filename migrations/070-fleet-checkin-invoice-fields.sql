-- Add invoice tracking fields to fleet_checkins for archived vehicle billing
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS date_invoiced DATE;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false;
