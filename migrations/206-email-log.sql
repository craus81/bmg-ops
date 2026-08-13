-- Universal email delivery log. Invoice emails (155) and estimate approval
-- emails (205) each grew bespoke delivery tracking; every other flow —
-- statements, wrap quotes, proofs, thread messages, digests, invites, staff
-- notifications — was fire-and-forget, so a bounce was invisible. Instead
-- of nine more bespoke schemas, the send layer (src/lib/resend.ts) now logs
-- EVERY send here, and the Resend webhook updates the row generically.
-- Composed sends (sent_by set) alert the sender on bounce; automated sends
-- surface on the System Health page's Email delivery section.
--
-- The invoice/estimate specializations stay: they carry flow-specific UI
-- and alert routing. This table is the safety net under everything.

CREATE TABLE IF NOT EXISTS email_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Resend message id; NULL = the hand-off to Resend itself failed (no
  -- webhook will ever arrive for it).
  source_id TEXT,
  -- Which flow sent it: 'invoice', 'estimate_approval', 'statement',
  -- 'wrap_quote', 'proof_approval', 'customer_thread', 'customer_notify',
  -- 'customer_digest', 'pickup_notice', 'staff_notification', 'invite',
  -- 'other'. Vocabulary lives at the call sites — no CHECK, new flows just
  -- pass a new slug.
  kind TEXT NOT NULL DEFAULT 'other',
  recipients TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  -- The user who composed/triggered the send. Set for human-composed sends
  -- (bounce alerts go to them); NULL for automated sends (crons, digests).
  sent_by UUID REFERENCES profiles(id),
  -- Deep link to the record the email is about, for the admin view and the
  -- bounce alert CTA.
  context_url TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'sent'
    CHECK (delivery_status IN ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed')),
  delivery_detail TEXT,
  delivery_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook lookups are by Resend message id; the admin view reads newest-first.
CREATE INDEX IF NOT EXISTS idx_email_log_source_id
  ON email_log(source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_log_created_at
  ON email_log(created_at DESC);

ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can read the email log' AND tablename = 'email_log') THEN
    CREATE POLICY "Internal staff can read the email log" ON email_log
      FOR SELECT TO authenticated
      USING (public.is_internal_staff());
  END IF;
END $$;

COMMENT ON TABLE email_log IS 'One row per outbound email, written by sendEmailDetailed. Delivery status updated by /api/webhooks/resend.';
