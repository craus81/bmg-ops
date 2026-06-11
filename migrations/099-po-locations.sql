-- Migration 092: Reusable ship-to locations for purchase orders
--
-- Until now ship_to on a PO was free-typed (or filled in by the AI
-- extractor) which meant the same address got re-entered for every PO.
-- This table stores a small list of named locations that can be picked
-- from a dropdown when creating or editing a PO. The PO itself still
-- stores its ship_to JSON so historical addresses are preserved even
-- if a saved location is renamed or archived later.

CREATE TABLE IF NOT EXISTS po_locations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_locations_active
  ON po_locations(archived, name);

ALTER TABLE po_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can manage po locations"
  ON po_locations FOR ALL
  TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
