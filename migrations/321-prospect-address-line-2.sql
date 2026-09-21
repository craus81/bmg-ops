-- Second address line on the CRM record, so a FleetSuite address edit can
-- round-trip through NetSuite without losing anything.
--
-- NetSuite stores a customer address as addr1 + addr2 + city/state/zip. The
-- CRM record had addr1 only, and the 2-hourly customer sync papered over
-- that by writing the WHOLE flattened address — "123 Main St, Suite 300,
-- Dallas, TX, 75201" — into the single `address` column, which the record
-- page then rendered again beside its own city/state/zip fields.
--
-- That was cosmetic while the edit form only wrote to Postgres. It stops
-- being cosmetic the moment the form pushes back: the flattened string
-- would go to NetSuite as addr1 and the real suite number would be
-- duplicated on the record. So `address` now means addr1 and nothing else,
-- and addr2 gets the column it always needed.

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS address2 TEXT;
