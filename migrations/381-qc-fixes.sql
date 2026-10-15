-- Migration 381: QC fixes reported by a customer's QC team.
--
-- Owner ask 2026-10-15: move BMG's QC fix process out of monday.com, and
-- make it simpler. Masterack's QC team (Chaquanna, QC director; Ron,
-- production manager) reports an issue on a vehicle we finished through a
-- link: last 6 of the VIN, a VIN photo, issue photos and optional comments;
-- the date is stamped. BMG sets a fix-by date, then marks it fixed.
--
--   * One link per customer (customers.qc_token), no login, like the
--     PO-status portal. Anyone holding it can report; each person types
--     their name once and the phone remembers it.
--   * When an issue is reported, the people on customers.qc_notify_emails
--     (Ron and Chaquanna) get an email straight away: it answers their own
--     team's action. BMG's super admins get a bell + push, no email.
--   * The "fixed" email is never automatic (owner, 2026-10-15: "i dont like
--     automatic emails"): Mark fixed opens the standard compose screen.
--
-- Written only by /api/qc/[token] (public, token-guarded) and
-- /api/qc-fixes (staff). Idempotent: IF NOT EXISTS throughout.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS qc_token UUID;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS qc_token_created_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS qc_notify_emails TEXT[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_qc_token
  ON customers (qc_token) WHERE qc_token IS NOT NULL;

COMMENT ON COLUMN customers.qc_token IS
  'FleetSuite-owned. Shared-link credential for reporting QC fixes (/qc/<token>, src/app/api/qc/[token]). NULL = no link. Regenerating replaces it (old link dies).';
COMMENT ON COLUMN customers.qc_notify_emails IS
  'FleetSuite-owned. Who at the customer is emailed when their team reports a QC fix (and who the fixed email is addressed to by default).';

CREATE TABLE IF NOT EXISTS qc_fix_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vin_last6 TEXT NOT NULL CHECK (vin_last6 ~ '^[A-Z0-9]{6}$'),
  -- The vehicle the last 6 matched, when exactly one VIN in FleetSuite ends that way.
  checkin_id UUID REFERENCES fleet_checkins(id) ON DELETE SET NULL,
  vin TEXT,
  vehicle_label TEXT,                  -- "2026 Ford Transit 148 EL", as matched
  reported_by_name TEXT NOT NULL,
  comments TEXT,
  -- new        waiting on BMG
  -- scheduled  BMG set a fix-by date
  -- fixed      done
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'scheduled', 'fixed')),
  fix_by DATE,
  note_to_customer TEXT,               -- shown on their link next to the fix-by date
  fixed_at TIMESTAMPTZ,
  fixed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  fixed_email_sent_at TIMESTAMPTZ,
  submit_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qc_fix_reports_customer ON qc_fix_reports(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qc_fix_reports_status ON qc_fix_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qc_fix_reports_vin ON qc_fix_reports(vin) WHERE vin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qc_fix_reports_checkin ON qc_fix_reports(checkin_id) WHERE checkin_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS qc_fix_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL until the report it was uploaded for is submitted (or staff attach it).
  report_id UUID REFERENCES qc_fix_reports(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- vin    the photo of the VIN
  -- issue  the problem
  -- fix    BMG's photo of the repair (staff only)
  kind TEXT NOT NULL CHECK (kind IN ('vin', 'issue', 'fix')),
  storage_path TEXT NOT NULL,          -- under the R2 'photos' prefix
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  size_bytes INTEGER,
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qc_fix_photos_report ON qc_fix_photos(report_id);

-- Server routes only (service role); nothing reads these from the browser.
ALTER TABLE qc_fix_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE qc_fix_photos ENABLE ROW LEVEL SECURITY;
