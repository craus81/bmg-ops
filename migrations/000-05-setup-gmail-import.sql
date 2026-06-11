-- Google OAuth token storage for Gmail PO import
CREATE TABLE IF NOT EXISTS google_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expiry_date TIMESTAMPTZ,
  scope TEXT,
  token_type TEXT DEFAULT 'Bearer',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Track which emails have already been imported
CREATE TABLE IF NOT EXISTS gmail_po_imports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  thread_id TEXT,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  received_at TIMESTAMPTZ,
  po_number TEXT,
  po_id UUID REFERENCES purchase_orders(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'imported', 'skipped', 'error')),
  error_message TEXT,
  attachment_filename TEXT,
  raw_extraction JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gmail_po_imports_message_id ON gmail_po_imports(message_id);
CREATE INDEX IF NOT EXISTS idx_gmail_po_imports_status ON gmail_po_imports(status);
CREATE INDEX IF NOT EXISTS idx_gmail_po_imports_po_number ON gmail_po_imports(po_number);

-- RLS policies
ALTER TABLE google_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_po_imports ENABLE ROW LEVEL SECURITY;

-- Only service role should access tokens (no RLS policy = blocked for anon/authenticated)
-- For gmail_po_imports, allow authenticated users to read
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admins can view gmail imports' AND tablename = 'gmail_po_imports') THEN
    CREATE POLICY "Admins can view gmail imports" ON gmail_po_imports FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
