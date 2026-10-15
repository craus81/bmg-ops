-- Migration 379: Dropbox client files, searchable inside FleetSuite.
--
-- Owner ask 2026-10-15: "copy all of our production files from our dropbox
-- into our fleetsuite database so we can search directly in app without
-- linking to dropbox ... it should also autosync". Craig chose the middle
-- option: index every file under Dropbox /OFFICE/Clients (570 GB, one
-- folder per client) and copy the light ones (PDFs and photos) to R2 so
-- they open instantly; the big .ai/.eps print files stay in Dropbox and are
-- fetched from there on download. File bytes never go in the database, only
-- this list (Supabase egress was over quota in Oct 2026).
--
-- He also asked that client folders match to customer records so a
-- customer's files show on their page: dropbox_client_folders.customer_id,
-- set automatically when the folder name clearly is one customer, offered
-- as candidates for an admin to confirm when it is a close call.
--
-- Written only by /api/cron/client-files (src/lib/client-files-sync.ts) and
-- the admin match route. Dropbox stays the place these files change;
-- nothing here writes back to Dropbox.
--
-- Idempotent: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS dropbox_client_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dropbox_id TEXT NOT NULL UNIQUE,     -- id:xxxx, kept through renames, so a link survives one
  path_lower TEXT NOT NULL,            -- /office/clients/home depot
  name TEXT NOT NULL,                  -- Home Depot (as Dropbox shows it)
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- auto       linked by the matcher (one clear customer)
  -- confirmed  linked by a person (sticks; the matcher never changes it)
  -- suggested  close calls in candidates, waiting for a person
  -- unmatched  nothing close; re-tried as customers are added
  -- none       a person said this folder is no customer (sticks)
  match_status TEXT NOT NULL DEFAULT 'unmatched'
    CHECK (match_status IN ('auto', 'confirmed', 'suggested', 'unmatched', 'none')),
  match_score NUMERIC(4,3),
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{customer_id, name, score}]
  matched_at TIMESTAMPTZ,
  matched_by UUID,                     -- profiles.id of the person who confirmed
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  latest_modified TIMESTAMPTZ,
  listed_run TEXT,                     -- last full listing that saw it
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dropbox_client_folders_path ON dropbox_client_folders(path_lower);
CREATE INDEX IF NOT EXISTS idx_dropbox_client_folders_customer ON dropbox_client_folders(customer_id);
CREATE INDEX IF NOT EXISTS idx_dropbox_client_folders_status ON dropbox_client_folders(match_status);

CREATE TABLE IF NOT EXISTS dropbox_client_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dropbox_id TEXT NOT NULL UNIQUE,     -- id:xxxx, stable across renames and moves
  folder_id UUID REFERENCES dropbox_client_folders(id) ON DELETE SET NULL,
  path_lower TEXT NOT NULL,
  path_display TEXT NOT NULL,          -- /OFFICE/Clients/Home Depot/PRINT/x.eps
  rel_path TEXT NOT NULL,              -- Home Depot/PRINT/x.eps (what search reads)
  name TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('pdf', 'photo', 'print', 'other')),
  size_bytes BIGINT NOT NULL DEFAULT 0,
  server_modified TIMESTAMPTZ,
  rev TEXT,
  -- Copy in R2 (prefix client-files): set when copied_rev = rev.
  r2_path TEXT,
  copied_rev TEXT,
  thumb_path TEXT,                     -- small PNG from Dropbox's thumbnailer
  -- Failed copies: tried again up to 3 times per revision, then left in
  -- Dropbox (still searchable and downloadable from there).
  copy_failed_rev TEXT,
  copy_attempts INTEGER NOT NULL DEFAULT 0,
  copy_error TEXT,
  listed_run TEXT,                     -- last full listing that saw it
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The copy queue: a live PDF or photo within the size cap whose copy is
  -- missing or older than Dropbox's revision (src/lib/client-files.ts
  -- isCopyable and MAX_COPY_BYTES; change both together).
  needs_copy BOOLEAN GENERATED ALWAYS AS (
    deleted_at IS NULL
    AND kind IN ('pdf', 'photo')
    AND size_bytes > 0 AND size_bytes <= 52428800
    AND copied_rev IS DISTINCT FROM rev
    AND NOT (copy_failed_rev IS NOT DISTINCT FROM rev AND copy_attempts >= 3)
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_dropbox_client_files_folder ON dropbox_client_files(folder_id, server_modified DESC);
CREATE INDEX IF NOT EXISTS idx_dropbox_client_files_modified ON dropbox_client_files(server_modified DESC, id);
CREATE INDEX IF NOT EXISTS idx_dropbox_client_files_path ON dropbox_client_files(path_lower);
CREATE INDEX IF NOT EXISTS idx_dropbox_client_files_copy_queue ON dropbox_client_files(server_modified DESC, id)
  WHERE needs_copy;
CREATE INDEX IF NOT EXISTS idx_dropbox_client_files_listed ON dropbox_client_files(listed_run) WHERE deleted_at IS NULL;

-- Search is the forgiving "contains" match (src/lib/loose-search.ts) on the
-- path under Clients, which holds the client, every folder and the file
-- name; a trigram index serves it (see migration 354).
DO $$
DECLARE
  ext_schema TEXT;
BEGIN
  SELECT n.nspname INTO ext_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';
  IF ext_schema IS NULL THEN
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
    ext_schema := 'extensions';
  END IF;

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_trgm_dropbox_client_files_rel_path ON public.dropbox_client_files USING gin (rel_path %I.gin_trgm_ops)',
    ext_schema
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_trgm_dropbox_client_folders_name ON public.dropbox_client_folders USING gin (name %I.gin_trgm_ops)',
    ext_schema
  );
END $$;

-- Per-folder counts for the customer page and the match list, refreshed by
-- the sync after a run that changed anything. Every UPDATE has a WHERE: the
-- API connections load safeupdate (migrations/README.md).
CREATE OR REPLACE FUNCTION refresh_dropbox_client_folder_stats()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE dropbox_client_folders f
  SET file_count = COALESCE(s.n, 0),
      total_bytes = COALESCE(s.bytes, 0),
      latest_modified = s.latest,
      updated_at = now()
  FROM (
    SELECT fo.id,
           count(fi.id) AS n,
           sum(fi.size_bytes) AS bytes,
           max(fi.server_modified) AS latest
    FROM dropbox_client_folders fo
    LEFT JOIN dropbox_client_files fi ON fi.folder_id = fo.id AND fi.deleted_at IS NULL
    GROUP BY fo.id
  ) s
  WHERE s.id = f.id
    AND (f.file_count IS DISTINCT FROM COALESCE(s.n, 0)
      OR f.total_bytes IS DISTINCT FROM COALESCE(s.bytes, 0)
      OR f.latest_modified IS DISTINCT FROM s.latest);
$$;

REVOKE ALL ON FUNCTION refresh_dropbox_client_folder_stats() FROM PUBLIC, anon, authenticated;

-- Staff read; writes come from the sync and the admin route (service role).
ALTER TABLE dropbox_client_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE dropbox_client_files ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read Dropbox client folders' AND tablename = 'dropbox_client_folders') THEN
    CREATE POLICY "Staff read Dropbox client folders" ON dropbox_client_folders
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read Dropbox client files' AND tablename = 'dropbox_client_files') THEN
    CREATE POLICY "Staff read Dropbox client files" ON dropbox_client_files
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;
