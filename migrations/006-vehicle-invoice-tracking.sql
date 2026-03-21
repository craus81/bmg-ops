-- Track which scanned vehicles have been invoiced directly in NetSuite
ALTER TABLE scanned_vehicles ADD COLUMN IF NOT EXISTS netsuite_invoice_id TEXT;
