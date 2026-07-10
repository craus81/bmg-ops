-- Wrap quotes can be pushed to NetSuite as an Estimate (NetSuite's quote
-- record): all vinyl/material pricing rolls into one "3M Vinyl" line
-- (description = the vehicle the quote was measured on) and all labor into
-- one "Graphics Install Labor" line; taxes are left to NetSuite. These
-- columns remember the created estimate so the UI can link to it and block
-- accidental duplicates.
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS netsuite_estimate_id TEXT;
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS netsuite_estimate_number TEXT;
