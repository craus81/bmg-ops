-- Migration 372: NetSuite estimates copied into FleetSuite.
--
-- Owner ask 2026-10-14: a search for "est526" in the top bar found nothing,
-- because EST526 was made in NetSuite and FleetSuite only ever knew about the
-- estimates it pushed there itself. Craig chose to copy every NetSuite
-- estimate (he wants all transactions in FleetSuite for the NetSuite
-- replacement anyway) rather than look them up live.
--
-- Same shape as the sales order copy (migration 196): headers plus item
-- lines, kept in step every two hours by /api/cron/netsuite-estimates
-- (src/lib/netsuite-estimate-sync.ts, the only writer). NetSuite stays the
-- place these change; FleetSuite never writes one back. estimate_id links a
-- row to the FleetSuite estimate that was pushed into it
-- (estimates.netsuite_estimate_id), so search can skip rows FleetSuite
-- already shows as its own estimate.
--
-- Idempotent: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS netsuite_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  netsuite_id TEXT NOT NULL UNIQUE,   -- transaction internal id
  tranid TEXT,                        -- estimate number as shown in NetSuite (EST526)
  customer_netsuite_id TEXT,
  customer_name TEXT,
  trandate DATE,
  status TEXT,                        -- raw NetSuite status code
  status_label TEXT,                  -- display name when available
  memo TEXT,
  otherrefnum TEXT,                   -- PO/Reference No.
  vin TEXT,                           -- custbody_vin_number_
  total NUMERIC(14,2),
  estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ns_estimates_date ON netsuite_estimates(trandate DESC);
CREATE INDEX IF NOT EXISTS idx_ns_estimates_customer ON netsuite_estimates(customer_netsuite_id);
CREATE INDEX IF NOT EXISTS idx_ns_estimates_estimate ON netsuite_estimates(estimate_id);

CREATE TABLE IF NOT EXISTS netsuite_estimate_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ns_estimate_id UUID NOT NULL REFERENCES netsuite_estimates(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,              -- transactionline id within the estimate
  item_netsuite_id TEXT,
  item_number TEXT,                   -- normalized (last ":" segment, uppercased)
  description TEXT,
  quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
  rate NUMERIC(14,4),
  amount NUMERIC(14,2),
  UNIQUE (ns_estimate_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_ns_estimate_lines_estimate ON netsuite_estimate_lines(ns_estimate_id);
CREATE INDEX IF NOT EXISTS idx_ns_estimate_lines_item ON netsuite_estimate_lines(item_number);

-- The top bar searches number, reference no., memo and customer as a
-- "contains" match; trigram indexes serve it (see migration 354).
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

  FOREACH col IN ARRAY ARRAY['tranid', 'otherrefnum', 'memo', 'customer_name'] LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.netsuite_estimates USING gin (%I %I.gin_trgm_ops)',
      'idx_trgm_netsuite_estimates_' || col, col, ext_schema
    );
  END LOOP;
END $$;

-- Staff read; writes come from the sync (service role).
ALTER TABLE netsuite_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE netsuite_estimate_lines ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read NetSuite estimates' AND tablename = 'netsuite_estimates') THEN
    CREATE POLICY "Staff read NetSuite estimates" ON netsuite_estimates
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read NetSuite estimate lines' AND tablename = 'netsuite_estimate_lines') THEN
    CREATE POLICY "Staff read NetSuite estimate lines" ON netsuite_estimate_lines
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;
