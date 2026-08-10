-- Migration 188: enforce single-primary on external_contacts at the DB level
-- (K2 groundwork — the primary contact is being surfaced on the customer
-- record, so the invariant needs to be real).
--
-- The API demotes siblings when promoting a primary, but the demotion used
-- to be skippable (a bare {is_primary: true} PATCH), so duplicates may
-- exist. Every consumer reads the primary with
-- .eq('is_primary', true).maybeSingle(), which THROWS on duplicates —
-- notification sends silently break for that customer. Dedupe (keep the
-- most recently updated), then lock it with a partial unique index.

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY customer_id
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id
         ) AS rn
  FROM external_contacts
  WHERE is_primary = true AND customer_id IS NOT NULL
)
UPDATE external_contacts ec
SET is_primary = false
FROM ranked r
WHERE ec.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_contacts_one_primary
  ON external_contacts(customer_id) WHERE is_primary;
