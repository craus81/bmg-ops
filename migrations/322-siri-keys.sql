-- Per-device keys for the iPhone app's Siri commands.
--
-- "Hey Siri, add a calendar entry in BMG FleetSuite" saves an event without
-- opening the app, so the Siri intent can't borrow the web view's Supabase
-- session (it lives in the WKWebView's storage, and the web view isn't
-- running). Instead the signed-in app mints one key per device
-- (/api/siri/key), stores it in the iPhone Keychain, and the intent sends it
-- to /api/siri/calendar-event.
--
-- Only a SHA-256 hash is stored, the key can do nothing but what the /api/siri
-- routes allow, and every use re-checks that the owner is still approved and
-- still has the Schedule feature. Signing out of the app revokes the key.

CREATE TABLE IF NOT EXISTS siri_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_siri_keys_hash ON siri_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_siri_keys_user ON siri_keys(user_id);

-- Written and read only through the service role (API routes); no client
-- access, so RLS on with no policies.
ALTER TABLE siri_keys ENABLE ROW LEVEL SECURITY;
