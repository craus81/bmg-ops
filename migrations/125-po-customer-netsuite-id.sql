-- POs carried the customer only as free text ("Masterack"), so every
-- downstream transaction (graphics jobs, sales orders, invoices) had to
-- re-resolve the name fuzzily against NetSuite and often failed (the real
-- customer is "Masterack LLC"). Store the NetSuite customer internal id on
-- the PO itself so it flows through to every transaction created from it.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS customer_netsuite_id TEXT;

COMMENT ON COLUMN purchase_orders.customer_netsuite_id IS
  'NetSuite customer internal id resolved from the customer name at import/creation time (see src/lib/customer-match.ts). Null = unresolved free-text customer.';
