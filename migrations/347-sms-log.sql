-- Migration 347: sms_log — one row per outbound customer text (owner ask
-- 2026-10-07).
--
-- Emails have email_log (206): every send, its recipients, body and
-- delivery status. Texts had nothing. The proof-approval link goes out by
-- text as well as email, but the only trace was a "(555…)" inside the job's
-- "Proof sent" history note — and a text skipped because texting is turned
-- off looked identical to one that went. The graphics job's approval
-- history now shows each text beside the emails, so it needs a record.
--
-- Same shape as email_log on purpose: context_url is the record the text is
-- about (the history reads by it), kind names the flow.

CREATE TABLE IF NOT EXISTS sms_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which flow sent it: 'proof_approval', 'pickup_notice', … No CHECK —
  -- vocabulary lives at the call sites, like email_log.kind.
  kind TEXT NOT NULL DEFAULT 'other',
  to_phone TEXT NOT NULL,
  body TEXT,
  provider_name TEXT,
  provider_sid TEXT,
  -- 'skipped' = texting is turned off (SMS_PROVIDER_ENABLED), nothing went.
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed', 'skipped')),
  error TEXT,
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  context_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_log_context
  ON sms_log(context_url, created_at)
  WHERE context_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_log_created_at
  ON sms_log(created_at DESC);

-- The proof-email lookup reads email_log by context_url too; until now only
-- the source_id and created_at indexes existed.
CREATE INDEX IF NOT EXISTS idx_email_log_context
  ON email_log(context_url, created_at)
  WHERE context_url IS NOT NULL;

ALTER TABLE sms_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can read the sms log' AND tablename = 'sms_log') THEN
    CREATE POLICY "Internal staff can read the sms log" ON sms_log
      FOR SELECT TO authenticated
      USING (public.is_internal_staff());
  END IF;
END $$;

COMMENT ON TABLE sms_log IS 'One row per outbound customer text, written by logSms (src/lib/sms-log.ts). Read by the graphics job approval history.';
