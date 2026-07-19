-- Parts ETAs from vendor emails: a domain-wide-delegated service account
-- reads watched BMG mailboxes for order confirmations / ship notices, AI
-- extracts PO number + dates + tracking, and the ETA lands on the synced
-- vendor PO (and any upfit project linked to it).

-- ── ETA fields on synced vendor POs ──────────────────────────────────────
ALTER TABLE netsuite_vendor_pos ADD COLUMN IF NOT EXISTS eta_date DATE;
ALTER TABLE netsuite_vendor_pos ADD COLUMN IF NOT EXISTS eta_source TEXT;   -- 'email' | 'manual'
ALTER TABLE netsuite_vendor_pos ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE netsuite_vendor_pos ADD COLUMN IF NOT EXISTS carrier TEXT;

-- ── Which mailboxes to watch (admin-editable in /admin/parts-mail) ───────
CREATE TABLE IF NOT EXISTS parts_email_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  mailboxes TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ,
  updated_by UUID REFERENCES profiles(id)
);
INSERT INTO parts_email_settings (id, mailboxes) VALUES (1, ARRAY[
  'admin@bmgfleet.com',
  'aownby@bmgfleet.com',
  'bspurgeon@bmgfleet.com',
  'cecibel@bmgfleet.com',
  'cgeorge@bmgfleet.com',
  'hgeorge@bmgfleet.com',
  'inquiry@bmgfleet.com',
  'james@bmgfleet.com',
  'jessie@bmgfleet.com',
  'vfleahman@bmgfleet.com',
  'zach@bmgfleet.com'
]) ON CONFLICT (id) DO NOTHING;

ALTER TABLE parts_email_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read parts email settings' AND tablename = 'parts_email_settings') THEN
    CREATE POLICY "Staff read parts email settings" ON parts_email_settings
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admins manage parts email settings' AND tablename = 'parts_email_settings') THEN
    CREATE POLICY "Admins manage parts email settings" ON parts_email_settings
      FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
  END IF;
END $$;

-- ── Every scanned email, so nothing is processed twice and misses are
--    reviewable instead of silent ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_shipment_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox TEXT NOT NULL,
  gmail_id TEXT NOT NULL,
  from_address TEXT,
  subject TEXT,
  received_at TIMESTAMPTZ,
  -- applied: PO matched and ETA/tracking written · linked: PO matched,
  -- nothing new to write · review: parts email but no PO match ·
  -- ignored: not a parts email · error: processing failed
  classification TEXT NOT NULL DEFAULT 'review'
    CHECK (classification IN ('applied', 'linked', 'review', 'ignored', 'error')),
  vendor_name TEXT,
  po_number TEXT,
  ship_date DATE,
  eta_date DATE,
  tracking_number TEXT,
  carrier TEXT,
  summary TEXT,
  matched_po_id UUID REFERENCES netsuite_vendor_pos(id) ON DELETE SET NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox, gmail_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_shipment_emails_class
  ON vendor_shipment_emails(classification, created_at DESC);

ALTER TABLE vendor_shipment_emails ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read shipment emails' AND tablename = 'vendor_shipment_emails') THEN
    CREATE POLICY "Staff read shipment emails" ON vendor_shipment_emails
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;
