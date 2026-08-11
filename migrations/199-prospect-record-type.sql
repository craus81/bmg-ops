-- Migration 199: Vendor records in the CRM (sales feedback)
--
-- Vendor/partner reps who stop by (bed manufacturers, equipment suppliers)
-- need their info captured, but entering them as customers pushes them to
-- NetSuite as Customer records. record_type keeps them in the same prospects
-- table (same contacts, activity, files) while the app skips the NetSuite
-- customer create and lists them under their own Vendors tab.

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS record_type TEXT NOT NULL DEFAULT 'customer';

ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_record_type_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_record_type_check
  CHECK (record_type IN ('customer', 'vendor'));
