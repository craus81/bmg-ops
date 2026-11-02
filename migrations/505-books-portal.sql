-- Migration 505: FleetSuite's own books, part 82 — the customer portal's
-- billing on FleetSuite's books, switched off.
--
-- The NetSuite Exit Checklist's "Money screens on FleetSuite's books"
-- (thread "Replacing NetSuite with FleetSuite", owner's go-ahead
-- 2026-10-31): the portal's Billing section and the customer dashboard's
-- billing card list a customer's open invoices read live from NetSuite.
-- With the switch on, they read the customer's open invoices in BMG's own
-- books in FleetSuite instead (src/lib/portal-billing.ts,
-- src/lib/books/money-screens.ts, docs/books.md "The portal"). Customers see
-- it, so it has a switch of its own rather than riding Financials':
--   * books_switches gets 'portal_books', off.
--
-- The switch is the only change.

DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%piece%'
  LOOP
    EXECUTE format('ALTER TABLE public.books_switches DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE books_switches ADD CONSTRAINT books_switches_piece_check
  CHECK (piece IN ('credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes',
                   'bill_fixes', 'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records',
                   'customer_payments', 'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals',
                   'own_numbers', 'invoice_pdfs', 'stock_counts', 'money_screens', 'portal_books'));

INSERT INTO books_switches (piece) VALUES ('portal_books') ON CONFLICT (piece) DO NOTHING;
