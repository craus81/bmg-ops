-- ============================================================================
-- Link POs to real NetSuite customers — run once in the Supabase SQL editor.
--
-- Does everything PR #171 needs on the database side:
--   1. Adds purchase_orders.customer_netsuite_id (migration 125)
--   2. Records migration 125 in schema_migrations so `npm run migrate`
--      won't try to re-apply it (no-op if the ledger table doesn't exist)
--   3. Backfills existing POs: resolves each free-text customer name to a
--      NetSuite customer using the same graded rules as the app
--      (src/lib/customer-match.ts) — exact company name → exact entity id →
--      prefix matching exactly ONE customer ("Masterack" → "Masterack LLC") →
--      substring matching exactly one. Ambiguous names are left unlinked,
--      never guessed.
--   4. Flows the resolved customer down to those POs' graphics jobs
--   5. Ends with a report: what got linked, and what couldn't be matched
--
-- Safe to re-run: every step is idempotent and only touches rows that are
-- still missing a customer_netsuite_id.
-- ============================================================================

-- 1. Add the column (migration 125)
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS customer_netsuite_id TEXT;

COMMENT ON COLUMN purchase_orders.customer_netsuite_id IS
  'NetSuite customer internal id resolved from the customer name at import/creation time (see src/lib/customer-match.ts). Null = unresolved free-text customer.';

-- 2. Keep the migration ledger consistent (only if the runner's table exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (filename)
    VALUES ('125-po-customer-netsuite-id.sql')
    ON CONFLICT (filename) DO NOTHING;
  END IF;
END $$;

-- 3. Resolve each distinct unlinked customer name to a NetSuite customer and
--    stamp it on the POs (id + canonical display name), all in one statement.
--    Tiers mirror src/lib/customer-match.ts; ILIKE wildcards in the raw name
--    are escaped so PDF noise can't become a pattern.
WITH names AS (
  SELECT DISTINCT trim(customer) AS raw_name
  FROM purchase_orders
  WHERE customer_netsuite_id IS NULL
    AND customer IS NOT NULL
    AND trim(customer) <> ''
    AND lower(trim(customer)) <> 'unknown'
),
resolved AS (
  SELECT n.raw_name, m.netsuite_id, m.company_name
  FROM names n
  CROSS JOIN LATERAL (
  SELECT cand.netsuite_id, cand.company_name
  FROM (
    -- Tier 1: exact company name (case-insensitive)
    SELECT c.netsuite_id, c.company_name, 1 AS tier
    FROM customers c
    WHERE c.active IS TRUE AND c.netsuite_id IS NOT NULL
      AND lower(c.company_name) = lower(n.raw_name)

    UNION ALL

    -- Tier 2: exact entity id
    SELECT c.netsuite_id, c.company_name, 2
    FROM customers c
    WHERE c.active IS TRUE AND c.netsuite_id IS NOT NULL
      AND lower(c.entity_id) = lower(n.raw_name)

    UNION ALL

    -- Tier 3: prefix — accepted only when exactly ONE active customer matches
    SELECT c.netsuite_id, c.company_name, 3
    FROM customers c
    WHERE c.active IS TRUE AND c.netsuite_id IS NOT NULL
      AND c.company_name ILIKE replace(replace(n.raw_name, '%', '\%'), '_', '\_') || '%'
      AND 1 = (
        SELECT count(*) FROM customers c2
        WHERE c2.active IS TRUE AND c2.netsuite_id IS NOT NULL
          AND c2.company_name ILIKE replace(replace(n.raw_name, '%', '\%'), '_', '\_') || '%'
      )

    UNION ALL

    -- Tier 4: substring, same single-match rule
    SELECT c.netsuite_id, c.company_name, 4
    FROM customers c
    WHERE c.active IS TRUE AND c.netsuite_id IS NOT NULL
      AND c.company_name ILIKE '%' || replace(replace(n.raw_name, '%', '\%'), '_', '\_') || '%'
      AND 1 = (
        SELECT count(*) FROM customers c2
        WHERE c2.active IS TRUE AND c2.netsuite_id IS NOT NULL
          AND c2.company_name ILIKE '%' || replace(replace(n.raw_name, '%', '\%'), '_', '\_') || '%'
      )
  ) cand
    ORDER BY cand.tier
    LIMIT 1
  ) m
)
UPDATE purchase_orders po
SET customer_netsuite_id = r.netsuite_id,
    customer = r.company_name
FROM resolved r
WHERE po.customer_netsuite_id IS NULL
  AND trim(po.customer) = r.raw_name;

-- 4. Flow the resolution down to graphics jobs linked to a resolved PO
UPDATE graphics_jobs gj
SET customer_netsuite_id = po.customer_netsuite_id,
    customer = po.customer
FROM purchase_orders po
WHERE gj.po_id = po.id
  AND gj.customer_netsuite_id IS NULL
  AND po.customer_netsuite_id IS NOT NULL;

-- 5. Report: linked customers first, then anything left unmatched.
--    Unmatched names stay as-is — fix the customer record (or the PO) and
--    re-run this file, or use the "Link Customers" button on the POs page.
SELECT
  CASE WHEN customer_netsuite_id IS NULL THEN '✗ unmatched' ELSE '✓ linked' END AS status,
  customer,
  customer_netsuite_id,
  count(*) AS po_count
FROM purchase_orders
WHERE customer IS NOT NULL AND trim(customer) <> ''
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 4 DESC;
