-- Migration 475: 06 items are untaxed services on Books' own invoice copies.
--
-- Owner decision 2026-10-31 (thread "Treat 06 items as non-taxable
-- services"): every item whose number starts with 06 (BMG's install and
-- service numbers) is untaxed, whatever item type NetSuite gives it, as
-- NetSuite already treats them. src/lib/line-taxability.ts carries the rule
-- from now on; this corrects the copies saved before it (INV2686's 06S646 was
-- taxed $73.54 where NetSuite charged none), so they match NetSuite again.
--
--   * a saved line whose item number starts with 06 and is taxed becomes
--     untaxed, unless an admin set that item to Taxed on the Parts page;
--   * the copy's tax and total are worked out again from its lines;
--   * a copy whose standing entry the books built from the copy itself
--     (own_invoice@1) is left as it is: it matched NetSuite as saved.
--
-- Nothing posts or changes in NetSuite. Runs once; running again finds nothing.

WITH posted_from_copy AS (
  SELECT DISTINCT e.source_id
  FROM public.gl_entries e
  WHERE e.source_type = 'invoice'
    AND e.posting_rule = 'own_invoice@1'
    AND e.source_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.gl_entries r WHERE r.reverses_entry_id = e.id)
),
taxed_by_admin AS (
  SELECT DISTINCT upper(btrim(item_number)) AS num FROM public.netsuite_parts WHERE taxable_override IS TRUE AND item_number IS NOT NULL
  UNION
  SELECT DISTINCT netsuite_id FROM public.netsuite_parts WHERE taxable_override IS TRUE AND netsuite_id IS NOT NULL
)
UPDATE public.gl_own_invoice_lines l
SET taxable = false, tax = 0
WHERE l.taxable
  AND btrim(coalesce(l.item_number, '')) LIKE '06%'
  AND l.invoice_id NOT IN (SELECT source_id FROM posted_from_copy)
  AND upper(btrim(l.item_number)) NOT IN (SELECT num FROM taxed_by_admin)
  AND coalesce(l.item_netsuite_id, '') NOT IN (SELECT num FROM taxed_by_admin);

-- Each copy's tax is its lines' tax (gl_own_invoice_save holds it to that), so a copy whose lines now add up to less
-- is one corrected above.
UPDATE public.gl_own_invoices i
SET tax = s.tax, total = i.subtotal + s.tax
FROM (
  SELECT invoice_id, sum(tax) AS tax FROM public.gl_own_invoice_lines GROUP BY invoice_id
) s
WHERE i.netsuite_id = s.invoice_id
  AND i.tax <> s.tax;
