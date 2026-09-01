-- PVO (Pro Vehicle Outlines) catalog + download queue
--
-- provehicleoutlines.com caps downloads at 25/day, so we index the whole
-- catalog once (browsing costs nothing) and work through it a batch a night.
-- This table is the queue: one row per PVO template, whether or not we have
-- downloaded it yet. Downloaded rows link to the vehicle_templates record.

CREATE TABLE IF NOT EXISTS pvo_catalog (
  pvo_id              TEXT PRIMARY KEY,           -- PVO's own template id (from showPreview(N))
  token               TEXT NOT NULL,              -- download token (from download('...'))
  description         TEXT NOT NULL,              -- raw card text, e.g. "2001-2005 Plymouth Voyager"
  make                TEXT,
  model               TEXT,
  years               TEXT,                       -- "2001-2005"
  year_start          TEXT,                       -- "2001"
  base_name           TEXT,                       -- sanitized "years make model", used for filenames
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | downloaded | failed
  priority_rank       INTEGER,                    -- lower = downloaded sooner (from pvo-priority.txt)
  vehicle_template_id UUID REFERENCES vehicle_templates(id) ON DELETE SET NULL,
  file_format         TEXT,                       -- ai | eps | pdf | cel
  error               TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  downloaded_at       TIMESTAMPTZ,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pvo_catalog_status_idx ON pvo_catalog (status);
CREATE INDEX IF NOT EXISTS pvo_catalog_queue_idx ON pvo_catalog (status, priority_rank);
CREATE INDEX IF NOT EXISTS pvo_catalog_base_name_idx ON pvo_catalog (base_name);

-- RLS — the sync script uses the service role; internal staff may read.
ALTER TABLE pvo_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage pvo_catalog" ON pvo_catalog;
CREATE POLICY "Service role can manage pvo_catalog"
  ON pvo_catalog FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "pvo_catalog_select" ON pvo_catalog;
CREATE POLICY "pvo_catalog_select"
  ON pvo_catalog FOR SELECT TO authenticated
  USING (public.is_internal_staff());

-- Last-run status lives in the existing sync_state table.
INSERT INTO sync_state (sync_type) VALUES ('pvo_templates')
ON CONFLICT DO NOTHING;
