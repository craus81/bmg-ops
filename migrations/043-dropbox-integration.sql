-- App settings table for storing integration tokens (Dropbox, etc.)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write app_settings (contains tokens)
CREATE POLICY "Service role only" ON app_settings
  FOR ALL USING (auth.role() = 'service_role');

-- Add proof-related columns to fleet_checkins
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS proof_url TEXT;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS proof_storage_key TEXT;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS proof_dropbox_path TEXT;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS proof_filename TEXT;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS proof_linked_at TIMESTAMPTZ;
