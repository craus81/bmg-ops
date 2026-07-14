-- PO notes: comments on purchase orders with @mentions, so the team can flag
-- a PO that needs fixing or attention and tag whoever should look at it.
-- Tagged users are notified through the existing notification channels.
CREATE TABLE IF NOT EXISTS po_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  author_id UUID REFERENCES profiles(id),
  body TEXT NOT NULL,
  -- profile ids tagged on this note
  mentions UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_notes_po ON po_notes(po_id);

ALTER TABLE po_notes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage po notes' AND tablename = 'po_notes') THEN
    CREATE POLICY "Internal staff can manage po notes" ON po_notes
      FOR ALL TO authenticated
      USING (public.is_internal_staff())
      WITH CHECK (public.is_internal_staff());
  END IF;
END $$;
