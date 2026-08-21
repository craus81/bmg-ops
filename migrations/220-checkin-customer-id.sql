-- Check-in customer becomes a real customer link (field ask, 2026-08-21:
-- "when you're checking in a vehicle, the customer is a free text form
-- instead of pulling from a customer list in NetSuite").
--
-- The check-in wizard's customer field is now a picker over the synced
-- customers table (with create-in-NetSuite when the name is new), and the
-- pick is stored here. customer_name stays as the denormalized display
-- every reader already uses; the SO path also resolves it to a local
-- customer when the SO's customer name matches exactly one record.
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);
