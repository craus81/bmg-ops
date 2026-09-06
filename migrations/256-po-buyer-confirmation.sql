-- PO buyer contact + automatic receipt confirmation.
--
-- Masterack POs carry a "Buyer Information" block (name + email of the
-- person who sent the PO). The import captured the ordered date and ship-to
-- from the PDF but not the buyer, so there was nobody to confirm receipt to.
-- Owner decision (2026-09-03): once a PO's lines are imported, email the
-- buyer a confirmation automatically — PO number, lines, requested
-- delivery dates, total, with the PO PDF attached — and record that it
-- went out on the PO.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS buyer_name TEXT,
  ADD COLUMN IF NOT EXISTS buyer_email TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_sent_to TEXT[];

COMMENT ON COLUMN purchase_orders.buyer_name IS
  'Buyer Information → Name from the PO PDF (the person at the customer who sent the PO). Extracted at import.';
COMMENT ON COLUMN purchase_orders.buyer_email IS
  'Buyer Information → Email from the PO PDF. Default recipient of the automatic receipt confirmation.';
COMMENT ON COLUMN purchase_orders.confirmation_sent_at IS
  'When the automatic receipt confirmation email went out (src/lib/po-confirmation.ts). Null = not sent (no lines imported yet, or no recipient could be resolved).';
COMMENT ON COLUMN purchase_orders.confirmation_sent_to IS
  'Recipients of the receipt confirmation (buyer email, or the customer''s billing emails when the PDF carried none).';
