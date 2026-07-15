-- Log every invoice email sent to a customer, so screens can show "already
-- emailed" before someone sends a duplicate. One row per invoice per send;
-- test sends (to the sender themselves) are not logged.
CREATE TABLE IF NOT EXISTS invoice_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT NOT NULL,
  netsuite_invoice_id TEXT,
  customer_name TEXT,
  recipients TEXT[] NOT NULL DEFAULT '{}',
  sent_by UUID REFERENCES profiles(id),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_emails_number ON invoice_emails(invoice_number);

ALTER TABLE invoice_emails ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage invoice emails' AND tablename = 'invoice_emails') THEN
    CREATE POLICY "Internal staff can manage invoice emails" ON invoice_emails
      FOR ALL TO authenticated
      USING (public.is_internal_staff())
      WITH CHECK (public.is_internal_staff());
  END IF;
END $$;
