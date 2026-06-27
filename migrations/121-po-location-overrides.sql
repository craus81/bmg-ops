-- Migration 121: Learned PO -> NetSuite location overrides
--
-- When staff apply a NetSuite location to a PO's invoices from the Invoice
-- Locations admin tool, the PO -> location decision is recorded here. Future
-- invoices created for that PO (scan, SO-transform, graphics) then book to the
-- learned location automatically, instead of re-deriving it from the rule —
-- which matters for POs the rule can't place (the "indeterminate" Masterack
-- ones). Since the same PO always means the same location, one decision per PO
-- is enough.
--
-- Keyed by the normalized (trimmed, upper-cased) PO number so it works whether
-- or not the PO exists as a row in purchase_orders.

CREATE TABLE IF NOT EXISTS po_location_overrides (
  po_number     TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL,
  location_name TEXT,
  updated_by    UUID REFERENCES profiles(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE po_location_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can manage po location overrides"
  ON po_location_overrides FOR ALL
  TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
