-- Migration 416: NetSuite sales orders in the top bar search.
--
-- Owner ask 2026-10-20: sales orders made in NetSuite should be findable by
-- number in the top bar, like NetSuite estimates (migration 372), so one can
-- be copied into a new estimate. The search is a "contains" match on the SO
-- number, reference no., memo and customer; memo and otherrefnum already
-- have trigram indexes (migration 354), so this adds the other two.
--
-- Idempotent: IF NOT EXISTS throughout.

DO $$
DECLARE
  ext_schema TEXT;
  col TEXT;
BEGIN
  SELECT n.nspname INTO ext_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';
  IF ext_schema IS NULL THEN
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
    ext_schema := 'extensions';
  END IF;

  FOREACH col IN ARRAY ARRAY['tranid', 'customer_name'] LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.netsuite_sales_orders USING gin (%I %I.gin_trgm_ops)',
      'idx_trgm_netsuite_sales_orders_' || col, col, ext_schema
    );
  END LOOP;
END $$;
