-- Migration 178: Link prospect_contacts rows to their NetSuite contact record.
--
-- In-app contact edits can then PATCH the same contact in NetSuite instead of
-- creating duplicates. Populated by /api/netsuite/contacts/sync (SuiteQL bulk
-- sync already selects the contact internal id) and by /api/prospects/contacts
-- when it creates a new NetSuite contact.

ALTER TABLE prospect_contacts ADD COLUMN IF NOT EXISTS netsuite_contact_id TEXT;
CREATE INDEX IF NOT EXISTS idx_prospect_contacts_netsuite ON prospect_contacts(netsuite_contact_id);
