-- Migration 264: guarded unique indexes on the NetSuite money columns
-- (§7.4 item 12 — "first LOOK, then add with a dupe-report step, never
-- blind: a blind build on dirty data blocks every deploy").
--
-- Each block: skip if ANY unique index already covers the column (the
-- hand-migrated era may hold one no migration file defines); otherwise
-- create the partial unique index ONLY when the data is clean, and on
-- dirty data RAISE WARNING with the duplicate count and create a plain
-- index instead — the deploy proceeds, the duplicates show up in
-- /admin/reports/netsuite-dupes, and the next deploy after cleanup
-- creates the unique index (this file is idempotent and re-runs).
--
-- prospects.netsuite_id already has its unique partial index (060).
-- The customers block also un-breaks promote-prospect's mirror upsert:
-- ON CONFLICT (netsuite_id) errors when no unique index exists, which
-- made every promotion's mirror write fail quietly (§7.4's new wrinkle);
-- the code side now degrades gracefully either way.

DO $$
DECLARE dupes INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
    WHERE t.relname = 'customers' AND i.indisunique AND i.indnatts = 1 AND a.attname = 'netsuite_id'
  ) THEN
    SELECT COUNT(*) INTO dupes FROM (
      SELECT netsuite_id FROM customers WHERE netsuite_id IS NOT NULL
      GROUP BY netsuite_id HAVING COUNT(*) > 1
    ) d;
    IF dupes = 0 THEN
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_customers_netsuite_id
        ON customers(netsuite_id) WHERE netsuite_id IS NOT NULL;
      RAISE NOTICE 'customers.netsuite_id: unique index created';
    ELSE
      RAISE WARNING 'customers.netsuite_id: % duplicated id(s) — unique index NOT created; clean them (see /admin/reports/netsuite-dupes) and redeploy', dupes;
      CREATE INDEX IF NOT EXISTS idx_customers_netsuite_id ON customers(netsuite_id);
    END IF;
  END IF;
END $$;

DO $$
DECLARE dupes INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
    WHERE t.relname = 'estimates' AND i.indisunique AND i.indnatts = 1 AND a.attname = 'netsuite_estimate_id'
  ) THEN
    SELECT COUNT(*) INTO dupes FROM (
      SELECT netsuite_estimate_id FROM estimates WHERE netsuite_estimate_id IS NOT NULL
      GROUP BY netsuite_estimate_id HAVING COUNT(*) > 1
    ) d;
    IF dupes = 0 THEN
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_estimates_netsuite_estimate_id
        ON estimates(netsuite_estimate_id) WHERE netsuite_estimate_id IS NOT NULL;
      RAISE NOTICE 'estimates.netsuite_estimate_id: unique index created';
    ELSE
      RAISE WARNING 'estimates.netsuite_estimate_id: % duplicated id(s) — unique index NOT created; clean them (see /admin/reports/netsuite-dupes) and redeploy', dupes;
      CREATE INDEX IF NOT EXISTS idx_estimates_netsuite_estimate_id ON estimates(netsuite_estimate_id);
    END IF;
  END IF;
END $$;

DO $$
DECLARE dupes INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
    WHERE t.relname = 'estimates' AND i.indisunique AND i.indnatts = 1 AND a.attname = 'netsuite_so_id'
  ) THEN
    SELECT COUNT(*) INTO dupes FROM (
      SELECT netsuite_so_id FROM estimates WHERE netsuite_so_id IS NOT NULL
      GROUP BY netsuite_so_id HAVING COUNT(*) > 1
    ) d;
    IF dupes = 0 THEN
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_estimates_netsuite_so_id
        ON estimates(netsuite_so_id) WHERE netsuite_so_id IS NOT NULL;
      RAISE NOTICE 'estimates.netsuite_so_id: unique index created';
    ELSE
      RAISE WARNING 'estimates.netsuite_so_id: % duplicated id(s) — unique index NOT created; clean them (see /admin/reports/netsuite-dupes) and redeploy', dupes;
      CREATE INDEX IF NOT EXISTS idx_estimates_netsuite_so_id ON estimates(netsuite_so_id);
    END IF;
  END IF;
END $$;
