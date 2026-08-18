-- Migration 210: billable customers — who the tech is working for
--
-- Craig 2026-08-18: field techs and CNI installers need to choose the
-- customer they're working for at scan time. Reading Truck and Masterack
-- are merging but for now run separate PO systems, separate AP departments,
-- and different-looking part numbers — and their graphics get installed in
-- the SAME buildings, so the work location can no longer imply the customer
-- (the old rule "any Masterack location bills Masterack LLC" would silently
-- mis-bill Reading work).
--
-- This table is the short pick-list the scan flow and the CNI job form
-- offer — a handful of companies BMG invoices for install work, NOT the
-- full synced NetSuite `customers` table. Adding a customer is an insert,
-- no deploy needed. src/lib/billable-customers.ts carries the same rows as
-- a fallback for sessions that load before this migration applies.
--
-- requires_po drives the Waiting-for-PO gate (with the existing per-part
-- netsuite_parts.requires_po_match): Masterack cuts POs up front, so their
-- scans wait for a PO match. Reading is invoice-first — BMG sends the
-- invoice and Reading cuts a PO after, except in rare pre-PO'd cases — so
-- Reading scans go straight to Ready to Export; when a Reading PO does
-- exist up front, the auto-matcher still attaches it.
--
-- IMPORTANT — this table may ALREADY EXIST with a different shape: an
-- earlier stranded session had Craig hand-paste its own billable_customers
-- SQL into the Supabase editor, and the first deploy of this migration
-- failed on it ("column display_label does not exist" — CREATE IF NOT
-- EXISTS skipped, the seed insert hit the old columns). So this migration
-- RECONCILES: it adds whatever columns are missing, backfills them
-- (preserving every existing row and value — the Reading row's name may
-- have been hand-corrected to the real NetSuite record), and only seeds a
-- customer when no row for it exists under any spelling.

CREATE TABLE IF NOT EXISTS billable_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical NetSuite company name: stamped on scans as billable_customer
  -- and matched by findCustomer when the invoice is created. Must equal the
  -- NetSuite customer record's company name or invoicing won't resolve it.
  name TEXT NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  -- Short label on the tech-facing buttons ("Reading Truck").
  display_label TEXT NOT NULL,
  -- FALSE = invoice-first: this customer's scans never wait for a PO.
  requires_po BOOLEAN NOT NULL DEFAULT TRUE,
  -- Other names the same customer appears under in part tags / old scans,
  -- for the fuzzy match in src/lib/billable-customers.ts.
  aliases TEXT[] NOT NULL DEFAULT '{}',
  sort_order INT NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bring a pre-existing hand-made table up to the spec above. Every branch
-- is a no-op on fresh installs (CREATE TABLE just made all columns exist).
DO $$
DECLARE
  has_col BOOLEAN;
  had_display_name BOOLEAN;
BEGIN
  -- display_label: prefer an old display_name column's values, then known
  -- labels for the standard trio, then fall back to the name itself.
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'billable_customers' AND column_name = 'display_label')
    INTO has_col;
  IF NOT has_col THEN
    ALTER TABLE billable_customers ADD COLUMN display_label TEXT;
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'billable_customers' AND column_name = 'display_name')
      INTO had_display_name;
    IF had_display_name THEN
      EXECUTE 'UPDATE billable_customers SET display_label = display_name WHERE display_name IS NOT NULL';
    END IF;
    UPDATE billable_customers SET display_label = 'Masterack'     WHERE display_label IS NULL AND name ILIKE 'masterack%';
    UPDATE billable_customers SET display_label = 'Reading Truck' WHERE display_label IS NULL AND name ILIKE 'reading%';
    UPDATE billable_customers SET display_label = COALESCE(name, 'Unknown') WHERE display_label IS NULL;
    ALTER TABLE billable_customers ALTER COLUMN display_label SET NOT NULL;
  END IF;

  -- requires_po: only when the column is newly added do we know the rows
  -- carry no human decision — mark Reading invoice-first then. An existing
  -- column's values are somebody's call; leave them alone.
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'billable_customers' AND column_name = 'requires_po')
    INTO has_col;
  IF NOT has_col THEN
    ALTER TABLE billable_customers ADD COLUMN requires_po BOOLEAN NOT NULL DEFAULT TRUE;
    UPDATE billable_customers SET requires_po = FALSE WHERE name ILIKE 'reading%';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'billable_customers' AND column_name = 'aliases')
    INTO has_col;
  IF NOT has_col THEN
    ALTER TABLE billable_customers ADD COLUMN aliases TEXT[] NOT NULL DEFAULT '{}';
    UPDATE billable_customers SET aliases = ARRAY['Masterack']                WHERE name ILIKE 'masterack%';
    UPDATE billable_customers SET aliases = ARRAY['Reading Truck', 'Reading'] WHERE name ILIKE 'reading%';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'billable_customers' AND column_name = 'sort_order')
    INTO has_col;
  IF NOT has_col THEN
    ALTER TABLE billable_customers ADD COLUMN sort_order INT NOT NULL DEFAULT 100;
    UPDATE billable_customers SET sort_order = 10 WHERE name ILIKE 'masterack%';
    UPDATE billable_customers SET sort_order = 20 WHERE name ILIKE 'reading%';
    UPDATE billable_customers SET sort_order = 30 WHERE name ILIKE 'designs that stick%';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'billable_customers' AND column_name = 'active')
    INTO has_col;
  IF NOT has_col THEN
    ALTER TABLE billable_customers ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'billable_customers' AND column_name = 'created_at')
    INTO has_col;
  IF NOT has_col THEN
    ALTER TABLE billable_customers ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;

  -- The spec says name is unique; a hand-made table may not enforce it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'billable_customers'
      AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%(name)%'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX billable_customers_name_uniq ON billable_customers (name)';
  END IF;
END $$;

COMMENT ON TABLE billable_customers IS
  'Pick-list of companies BMG invoices for install work — what techs/installers choose at scan time. name must equal the NetSuite customer company name. requires_po FALSE = invoice-first (scans skip the Waiting-for-PO gate).';

-- Techs and installers read the list client-side on the scan page; writes
-- stay service-role / SQL only (no write policies). Recreate our policy so
-- a re-run (or a hand-made predecessor with the same name) can't collide.
ALTER TABLE billable_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billable_customers_read ON billable_customers;
CREATE POLICY billable_customers_read ON billable_customers
  FOR SELECT TO authenticated USING (true);

-- Seed only customers that don't exist under ANY spelling — a hand-renamed
-- row (e.g. Reading corrected to its real NetSuite name) must not come back
-- as a duplicate under the canonical name.
INSERT INTO billable_customers (name, display_label, requires_po, aliases, sort_order)
SELECT 'Masterack LLC', 'Masterack', TRUE, ARRAY['Masterack'], 10
WHERE NOT EXISTS (SELECT 1 FROM billable_customers WHERE name ILIKE 'masterack%');

INSERT INTO billable_customers (name, display_label, requires_po, aliases, sort_order)
SELECT 'Reading Equipment and Distribution', 'Reading Truck', FALSE, ARRAY['Reading Truck', 'Reading'], 20
WHERE NOT EXISTS (SELECT 1 FROM billable_customers WHERE name ILIKE 'reading%');

INSERT INTO billable_customers (name, display_label, requires_po, aliases, sort_order)
SELECT 'Designs That Stick', 'Designs That Stick', TRUE, ARRAY[]::TEXT[], 30
WHERE NOT EXISTS (SELECT 1 FROM billable_customers WHERE name ILIKE 'designs that stick%');
