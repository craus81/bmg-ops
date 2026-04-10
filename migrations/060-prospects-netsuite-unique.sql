-- Migration 060: Add unique constraint on prospects.netsuite_id for upsert from NetSuite sync
-- Only applies to non-null values (multiple prospects can have null netsuite_id)

DROP INDEX IF EXISTS idx_prospects_netsuite;
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_netsuite_unique ON prospects(netsuite_id) WHERE netsuite_id IS NOT NULL;
