-- Migration 420: link estimates quoted for a prospect that has since become
-- a NetSuite customer.
--
-- EST-2610-024 (Craig, 2026-10-20): approved while the customer was a
-- prospect; the prospect was promoted later, but the estimate kept a null
-- customer_netsuite_id, so Convert to Sales Order never appeared.
-- promoteProspect (src/lib/promote-prospect.ts) now links these at
-- promotion time; this backfills the ones promoted before that.
-- Idempotent: only rows still missing the NetSuite id are touched.

UPDATE public.estimates e
SET customer_netsuite_id = p.netsuite_id::text,
    customer_id = COALESCE(e.customer_id, (
      SELECT c.id FROM public.customers c
      WHERE c.netsuite_id::text = p.netsuite_id::text
      ORDER BY c.id
      LIMIT 1
    ))
FROM public.prospects p
WHERE e.prospect_id = p.id
  AND e.customer_netsuite_id IS NULL
  AND p.netsuite_id IS NOT NULL;
