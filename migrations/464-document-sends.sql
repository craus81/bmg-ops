-- Every document shows if, when and to whom it was sent (Craig, 2026-10-31:
-- "we should have every transaction show if and when and to whom it has
-- been sent").
--
-- 1. email_log.doc_refs — which documents an email carried, as
--    '<type>:<key>' strings (src/lib/document-sends.ts builds them):
--    estimate:<uuid>, pro_forma:<estimate uuid>, invoice:<INV number>,
--    sales_order:<SO number>, vendor_po:<PO number>, customer_po:<uuid>,
--    graphics_job:<uuid>, statement:<NetSuite customer id>,
--    wrap_quote:<uuid>. One email can carry several (a 3-invoice send, a
--    batch of estimate PDFs). Older rows are backfilled from context_url,
--    which already named the one record each email was about.
--
-- 2. document_send_marks — sends FleetSuite did not make itself: a person
--    pressing "Mark as sent" (emailed from NetSuite, from their own email,
--    mailed, handed over), and sends the Sent-mail scan finds in the
--    watched BMG mailboxes (the same list the parts ETA scan reads).

ALTER TABLE email_log ADD COLUMN IF NOT EXISTS doc_refs TEXT[];

CREATE INDEX IF NOT EXISTS idx_email_log_doc_refs
  ON email_log USING GIN (doc_refs)
  WHERE doc_refs IS NOT NULL;

-- Backfill from the deep link each send already carried.
UPDATE email_log
   SET doc_refs = ARRAY['estimate:' || substring(context_url FROM '^/estimates\?id=([0-9a-fA-F-]{36})')]
 WHERE doc_refs IS NULL
   AND context_url ~ '^/estimates\?id=[0-9a-fA-F-]{36}';

UPDATE email_log
   SET doc_refs = ARRAY['customer_po:' || substring(context_url FROM '^/admin/pos/([0-9a-fA-F-]{36})')]
 WHERE doc_refs IS NULL
   AND context_url ~ '^/admin/pos/[0-9a-fA-F-]{36}';

UPDATE email_log
   SET doc_refs = ARRAY['graphics_job:' || substring(context_url FROM '^/graphics/([0-9a-fA-F-]{36})')]
 WHERE doc_refs IS NULL
   AND context_url ~ '^/graphics/[0-9a-fA-F-]{36}';

UPDATE email_log
   SET doc_refs = ARRAY['wrap_quote:' || substring(context_url FROM '^/admin/wrap-quote\?id=([0-9a-fA-F-]{36})')]
 WHERE doc_refs IS NULL
   AND context_url ~ '^/admin/wrap-quote\?id=[0-9a-fA-F-]{36}';

UPDATE email_log
   SET doc_refs = ARRAY['statement:' || substring(context_url FROM '^/admin/prospects/ns-([0-9]+)')]
 WHERE doc_refs IS NULL
   AND kind = 'statement'
   AND context_url ~ '^/admin/prospects/ns-[0-9]+';

UPDATE email_log
   SET doc_refs = ARRAY['invoice:' || substring(context_url FROM '[?&]invoice=([^&]+)')]
 WHERE doc_refs IS NULL
   AND kind = 'invoice'
   AND context_url ~ '[?&]invoice=[^&]+';

CREATE TABLE IF NOT EXISTS document_send_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_ref TEXT NOT NULL,
  -- 'netsuite' | 'own_email' | 'mail' | 'in_person' — a person's mark;
  -- 'sent_mail' — found in a watched mailbox's Sent folder.
  method TEXT NOT NULL CHECK (method IN ('netsuite', 'own_email', 'mail', 'in_person', 'sent_mail')),
  recipients TEXT[] NOT NULL DEFAULT '{}',
  sent_at TIMESTAMPTZ NOT NULL,
  -- Who pressed Mark as sent; NULL for scan finds.
  marked_by UUID REFERENCES profiles(id),
  -- Scan finds: whose Sent folder, the Gmail message id, and its subject.
  mailbox TEXT,
  gmail_message_id TEXT,
  subject TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_send_marks_ref
  ON document_send_marks (doc_ref, sent_at DESC);

-- A re-scan of the same Sent folder is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_send_marks_found
  ON document_send_marks (mailbox, gmail_message_id, doc_ref)
  WHERE gmail_message_id IS NOT NULL;

ALTER TABLE document_send_marks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can read document send marks' AND tablename = 'document_send_marks') THEN
    CREATE POLICY "Internal staff can read document send marks" ON document_send_marks
      FOR SELECT TO authenticated
      USING (public.is_internal_staff());
  END IF;
END $$;

COMMENT ON COLUMN email_log.doc_refs IS 'Migration 464: the documents this email carried, as type:key strings (src/lib/document-sends.ts). Read by every Sent box and the lists'' Sent column.';
COMMENT ON TABLE document_send_marks IS 'Migration 464: sends FleetSuite did not make itself — Mark as sent, and finds in watched mailboxes'' Sent folders.';
