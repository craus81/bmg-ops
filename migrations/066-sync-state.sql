-- Tracks the last successful sync time for each sync type
-- Used by the auto-sync cron to only fetch records modified since last run
CREATE TABLE IF NOT EXISTS sync_state (
  sync_type TEXT PRIMARY KEY,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT '2020-01-01T00:00:00Z',
  last_result JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed with initial sync types
INSERT INTO sync_state (sync_type) VALUES ('netsuite_customers'), ('netsuite_contacts')
ON CONFLICT DO NOTHING;

-- RLS — service role only
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage sync_state"
  ON sync_state FOR ALL
  USING (auth.role() = 'service_role');
