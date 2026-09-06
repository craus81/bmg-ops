-- Migration 252: per-item taxability, synced from NetSuite.
--
-- FleetSuite taxed every non-labor line. NetSuite does not: on estimate
-- EST942 the Freight line ($150) is non-taxable there, so FleetSuite quoted
-- $321.70 tax and NetSuite billed $309.76 — the customer signed a total
-- $11.94 higher than the invoice. Labor was already excluded on both sides,
-- and tax-exempt customers are handled by the estimate's own checkbox; the
-- gap was only ever per-ITEM taxability, which FleetSuite had no copy of.
--
-- NULL means "NetSuite didn't tell us", and the totals math treats that as
-- TAXABLE — today's behavior. So an account whose SuiteQL doesn't expose the
-- field, or items not yet re-synced, keep quoting exactly as they do now
-- rather than silently under-charging tax.
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS is_taxable BOOLEAN;

COMMENT ON COLUMN netsuite_parts.is_taxable IS
  'NetSuite item taxability. NULL = unknown, treated as taxable by computeTotals.';
