-- Audit trail for money-touching mutations. Most such writes flow through a
-- handful of service-role API routes (which bypass RLS), so a single log
-- table + a helper called from those routes covers ~90% of "who changed
-- this?" questions: bulk scan billing edits, part price changes, pay-rate
-- changes, payout lifecycle transitions, vendor-invoice create/delete, and
-- pay-credit corrections.

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES profiles(id),
  table_name TEXT NOT NULL,
  -- uuid or business key (e.g. a part number for pay rates); NULL for bulk
  -- actions whose targets are listed in detail.
  record_id TEXT,
  action TEXT NOT NULL,
  -- before/after values and context — shape varies per action.
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_record ON audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Admins read; writes come only from service-role routes (no insert policy).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admins can read audit log' AND tablename = 'audit_log') THEN
    CREATE POLICY "Admins can read audit log" ON audit_log
      FOR SELECT TO authenticated
      USING (public.is_admin());
  END IF;
END $$;

-- Payout transitions previously recorded no actor/time beyond approval.
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS billed_by UUID REFERENCES profiles(id);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS billed_at TIMESTAMPTZ;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES profiles(id);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
