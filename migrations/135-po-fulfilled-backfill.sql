-- One-time backfill: mark already-fulfilled POs complete.
--
-- Scan matching now flips a PO to 'complete' automatically the moment its
-- last remaining unit is installed (src/lib/scan-match.ts
-- recomputePoFulfillment). POs that hit 100% before that change shipped are
-- still sitting at 'open' — sweep them once so the new Fulfilled tab starts
-- accurate. Same rule as the code: at least one line, real quantity, and
-- every line's installed count meets its quantity.
UPDATE purchase_orders po
SET status = 'complete'
WHERE po.status = 'open'
  AND EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = po.id)
  AND (SELECT COALESCE(SUM(l.quantity), 0) FROM po_line_items l WHERE l.po_id = po.id) > 0
  AND NOT EXISTS (
    SELECT 1 FROM po_line_items l
    WHERE l.po_id = po.id AND COALESCE(l.installed, 0) < COALESCE(l.quantity, 0)
  );
