-- Migration 479: FleetSuite's own books, part 47 — estimates stay in
-- FleetSuite, switched off until it's turned on.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking, and in January
-- estimates stop going to NetSuite; each piece that changes how the team
-- works is built switched off. Once this one is on, nobody pushes an
-- estimate to NetSuite, and NetSuite gets each job's sales order when it's
-- made, as now (src/lib/estimates-in-fleetsuite.ts, /api/estimates/push,
-- /api/wrap-quote/netsuite; docs/books.md "Estimates in FleetSuite only").
--
--   * books_switches takes a tenth piece, estimates_in_fleetsuite, off.
--
-- Writer and reader: the service role only, as migration 466 left them.

-- Migration 478 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all ten.
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
                   'bill_fixes', 'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite'));

INSERT INTO books_switches (piece) VALUES ('estimates_in_fleetsuite') ON CONFLICT (piece) DO NOTHING;
