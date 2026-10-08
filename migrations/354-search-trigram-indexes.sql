-- Universal search over memos and notes (owner request 2026-10-08).
--
-- The search box now matches words inside QuickBooks memos and line text,
-- NetSuite invoice / sales order / vendor PO memos, QuickBooks bills, and
-- the notes on vehicles, POs, graphics jobs, upfit projects and estimates
-- (src/lib/deep-search.ts). Those are `ILIKE '%words%'` matches, which a
-- plain b-tree can't serve, so without these every keystroke would scan the
-- tables. A trigram GIN index answers a "contains" match of three or more
-- characters, which is why the search only runs these groups from three.
--
-- pg_trgm goes in Supabase's `extensions` schema. If it was already enabled
-- somewhere else, that copy is used: the opclass is looked up from wherever
-- the extension actually lives rather than assumed.
--
-- Idempotent: IF NOT EXISTS throughout.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

DO $$
DECLARE
  ext_schema TEXT;
  spec TEXT[];
  specs TEXT[][] := ARRAY[
    -- table, column
    ARRAY['ledger_invoices', 'memo'],
    ARRAY['ledger_invoices', 'private_note'],
    ARRAY['ledger_invoices', 'po_number'],
    ARRAY['ledger_invoices', 'party_name'],
    ARRAY['ledger_invoices', 'doc_number'],
    ARRAY['ledger_invoice_lines', 'description'],
    ARRAY['ledger_invoice_lines', 'item_name'],
    ARRAY['ledger_bills', 'memo'],
    ARRAY['ledger_bills', 'private_note'],
    ARRAY['ledger_bills', 'vendor_name'],
    ARRAY['ledger_bills', 'doc_number'],
    ARRAY['ledger_bill_lines', 'description'],
    ARRAY['netsuite_sales_orders', 'memo'],
    ARRAY['netsuite_sales_orders', 'otherrefnum'],
    ARRAY['netsuite_vendor_pos', 'memo'],
    ARRAY['netsuite_vendor_pos', 'vendor_name'],
    ARRAY['vehicle_notes', 'note'],
    ARRAY['po_notes', 'body'],
    ARRAY['graphics_status_history', 'note'],
    ARRAY['graphics_jobs', 'notes'],
    ARRAY['upfit_project_notes', 'content'],
    ARRAY['estimates', 'notes']
  ];
BEGIN
  SELECT n.nspname INTO ext_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';

  FOREACH spec SLICE 1 IN ARRAY specs LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I USING gin (%I %I.gin_trgm_ops)',
      'idx_trgm_' || spec[1] || '_' || spec[2], spec[1], spec[2], ext_schema
    );
  END LOOP;
END $$;
