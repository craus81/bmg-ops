-- Migration 246: repair estimates.netsuite_so_id / netsuite_so_number.
--
-- Field report 2026-08-31: converting an estimate created Sales Order SO1064
-- in NetSuite, then the write-back failed with
--   PGRST204: Could not find the 'netsuite_so_id' column of 'estimates'
--             in the schema cache
-- leaving a real SO in NetSuite with nothing pointing at it.
--
-- Those columns were added by migration 067, so there are two ways to get
-- here and this file fixes both, because from outside the database they are
-- indistinguishable:
--
--   1. The columns are genuinely absent -- 067 predates the migration runner
--      and would have been recorded by `npm run migrate:baseline`, which
--      marks files applied WITHOUT running them. A file that was never
--      hand-applied is invisible to the runner forever after.
--   2. The columns exist but PostgREST's schema cache never picked them up.
--      PostgREST resolves writes against a cached schema; a column missing
--      from that cache is rejected exactly like a column that isn't there.
--
-- The ADD COLUMN IF NOT EXISTS is a no-op in case 2, the NOTIFY is a no-op in
-- case 1 (the reload happens anyway via Supabase's DDL event trigger), and
-- the verification block below fails the deploy if the columns still aren't
-- real afterwards -- so this can't "succeed" while leaving the bug in place.
--
-- Why this matters beyond one stranded SO: every "already converted" guard in
-- the app reads estimates.netsuite_so_id. When that column can't be seen, the
-- guard is silently false and each conversion attempt creates ANOTHER real
-- Sales Order in NetSuite.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS netsuite_so_id text;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS netsuite_so_number text;

-- Convert-to-so stamps this first-writer-wins with
-- `.is('netsuite_so_id', null)`; the partial index keeps that guard and the
-- "which estimate owns this SO?" lookups cheap.
CREATE INDEX IF NOT EXISTS idx_estimates_netsuite_so_id
  ON estimates(netsuite_so_id) WHERE netsuite_so_id IS NOT NULL;

-- Fail the deploy rather than ship code whose schema silently isn't there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'estimates'
      AND column_name IN ('netsuite_so_id', 'netsuite_so_number')
    GROUP BY table_name HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION
      'estimates is still missing netsuite_so_id/netsuite_so_number after this migration';
  END IF;
END $$;

-- Force PostgREST to re-read the schema so the very next write sees the
-- columns, instead of waiting for the next cache refresh.
NOTIFY pgrst, 'reload schema';
