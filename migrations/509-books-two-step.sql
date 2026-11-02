-- Migration 509: FleetSuite's own books, part 87 — two-step sign-in for the
-- money roles, switched off.
--
-- The NetSuite Exit Checklist's "Controls" (thread "Replacing NetSuite with
-- FleetSuite", owner's go-ahead 2026-10-31). Supabase Auth keeps each
-- person's authenticator app (a TOTP factor), and a sign-in that has given
-- its code is at `aal2`. With this switch on, FleetSuite asks everyone who
-- holds a money role (super admin, executive, finance, bookkeeper, CPA) for
-- that code when they sign in, and anyone who hasn't set it up is asked to
-- set it up first (src/lib/two-step.ts, requireAuth in src/lib/api-auth.ts,
-- docs/books.md "Two-step sign-in"). Someone who has set it up is asked for
-- the code whether the switch is on or not.
--   * books_switches gets 'two_step_sign_in', off.
--
-- The switch is the only change: the authenticators live in Supabase Auth.

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
                   'own_numbers', 'invoice_pdfs', 'stock_counts', 'money_screens', 'portal_books', 'two_step_sign_in'));

INSERT INTO books_switches (piece) VALUES ('two_step_sign_in') ON CONFLICT (piece) DO NOTHING;
