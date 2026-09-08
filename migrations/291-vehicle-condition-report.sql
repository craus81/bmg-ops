-- R6-10: the vehicle condition report, and the customer's acknowledgment
-- of it.
--
-- Today pre-existing damage is a photo set plus one free-text note on the
-- check-in (fleet_checkins.damage_note). That is enough to remember what
-- the yard saw; it is not enough to answer "was this dent here when the
-- vehicle arrived?" six weeks later, because nothing records WHERE on the
-- vehicle, HOW BAD, or — the part that actually settles an argument —
-- that the customer looked at the record and agreed with it.
--
-- Two halves:
--   1. vehicle_damage_records makes each piece of damage its own row with
--      a location, a severity and its own photos.
--   2. The check-in gains odometer/fuel plus a tokenized acknowledgment
--      reusing the E-SIGN machinery proven on estimates and proofs:
--      single-purpose token, expiry, IP/UA/timestamp forensics, and a
--      frozen HTML snapshot with a content hash so the record cannot be
--      quietly edited after the customer agreed to it.
--
-- What the acknowledgment IS and IS NOT: the customer confirms the
-- recorded condition is accurate as of drop-off. It is deliberately NOT a
-- liability waiver or a release of claims — writing one of those into the
-- app is a decision for the business and its counsel, not a schema.

CREATE TABLE IF NOT EXISTS vehicle_damage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_id UUID NOT NULL REFERENCES fleet_checkins(id) ON DELETE CASCADE,

  -- Where on the vehicle. Free text rather than an enum: a body panel
  -- vocabulary that doesn't fit the vehicle in front of somebody is how
  -- you get every dent filed under "other".
  location TEXT,
  severity TEXT NOT NULL DEFAULT 'minor'
    CHECK (severity IN ('minor', 'moderate', 'severe')),
  description TEXT NOT NULL,
  -- storage paths in the `photos` bucket, same as vehicle_photos.
  photo_paths TEXT[] NOT NULL DEFAULT '{}',

  recorded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE vehicle_damage_records IS
  'Pre-existing damage found at check-in, one row per finding (R6-10). Supersedes the single fleet_checkins.damage_note for new check-ins; the old column is left in place and still read for history.';

CREATE INDEX IF NOT EXISTS idx_vehicle_damage_checkin
  ON vehicle_damage_records(checkin_id, created_at);

ALTER TABLE vehicle_damage_records ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Staff read damage records' AND tablename = 'vehicle_damage_records'
  ) THEN
    CREATE POLICY "Staff read damage records" ON vehicle_damage_records
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

ALTER TABLE fleet_checkins
  ADD COLUMN IF NOT EXISTS odometer_miles INTEGER,
  -- Coarse on purpose: a gauge read at a counter is not a measurement,
  -- and a decimal here would claim a precision nobody has.
  ADD COLUMN IF NOT EXISTS fuel_level TEXT
    CHECK (fuel_level IS NULL OR fuel_level IN ('empty', 'quarter', 'half', 'three_quarter', 'full')),

  -- Acknowledgment: single-purpose token, never reused for anything else.
  ADD COLUMN IF NOT EXISTS condition_token TEXT,
  ADD COLUMN IF NOT EXISTS condition_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS condition_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS condition_ack_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS condition_ack_name TEXT,
  ADD COLUMN IF NOT EXISTS condition_ack_ip TEXT,
  ADD COLUMN IF NOT EXISTS condition_ack_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS condition_ack_agreement_text TEXT,
  -- The frozen render + its hash: what the customer actually saw.
  ADD COLUMN IF NOT EXISTS condition_ack_document_path TEXT,
  ADD COLUMN IF NOT EXISTS condition_ack_document_hash TEXT,
  -- Fingerprint of the condition AS SENT. The acknowledge route recomputes
  -- it and refuses on mismatch, so damage edited while the link was live
  -- can't be frozen into a record the customer never saw — the same
  -- edit-during-approval hole migration 242 closed for estimates.
  ADD COLUMN IF NOT EXISTS condition_sent_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_checkins_condition_token
  ON fleet_checkins(condition_token) WHERE condition_token IS NOT NULL;

COMMENT ON COLUMN fleet_checkins.condition_sent_hash IS
  'sha256 of the condition record at send time. Acknowledgment refuses on mismatch so a post-send edit cannot be signed for.';
