-- Customer PO number + expiration date on estimates.
--
-- Field ask (Valarie, 2026-08-21): orders entered in FleetSuite reached
-- NetSuite without the header fields she fills when entering directly in
-- NetSuite — the customer's PO and the quote's expiration date had no home
-- here at all. Both are captured in the estimate builder, print on the
-- customer-facing estimate document, and push to NetSuite:
--   po_number       -> otherRefNum on the NS estimate and on convert-to-SO
--                      (where it now wins over our own estimate number)
--   expiration_date -> dueDate ("Expires") on the NS estimate
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS po_number TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS expiration_date DATE;
