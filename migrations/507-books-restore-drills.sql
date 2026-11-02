-- Migration 507: FleetSuite's own books, part 85 — the restore drill.
--
-- The rest of the NetSuite Exit Checklist's "Backups" (thread "Replacing
-- NetSuite with FleetSuite", building every piece since 2026-10-31): a backup
-- (part 84, migration 506) only counts once it's been put back. Each night,
-- after the backup, src/lib/books/restore-drill.ts takes the newest good one
-- out of BMG's file storage and restores it into a scratch database of its
-- own, built from FleetSuite's migrations the way docs/books.md "Backups"
-- says a restore is done, and checks the books came back whole. This adds:
--   * books_restore_drills, a row for each drill: the backup it restored,
--     nightly or by hand and who asked, when it started and finished, passed
--     or failed and why, the migration the scratch database was built to, and
--     what came back: tables, rows, journal entries and lines, and the links
--     between the books' tables checked. A row only changes while it's
--     running, and stays;
--   * books_restore_drill_begin(p), which starts one on a made backup: at
--     most one runs at a time, one that stopped without finishing is marked
--     failed after ten minutes, and the nightly one skips a backup that has
--     already passed. It hands back the backup's file, size and SHA-256;
--   * books_restore_drill_finish(p), which writes how it went.
--
-- Nothing in the books changes: the scratch database lives in the drill's
-- own memory and is thrown away with it. Nothing goes to NetSuite. Writer
-- and reader: the service role only.

-- ── The drills ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS books_restore_drills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id UUID NOT NULL REFERENCES books_backups(id),
  how TEXT NOT NULL CHECK (how IN ('nightly', 'by_hand')),
  -- profiles.id of who pressed Test restore now, kept without a foreign key as the backups keep who asked.
  asked_by UUID,
  asked_by_name TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed')),
  -- The backup's latest migration, which the scratch database is built up to.
  migration TEXT,
  table_count INT CHECK (table_count IS NULL OR table_count >= 0),
  row_count BIGINT CHECK (row_count IS NULL OR row_count >= 0),
  entry_count BIGINT CHECK (entry_count IS NULL OR entry_count >= 0),
  line_count BIGINT CHECK (line_count IS NULL OR line_count >= 0),
  -- The foreign keys between the books' tables whose every row was found to point at a row that's there.
  link_count INT CHECK (link_count IS NULL OR link_count >= 0),
  error TEXT CHECK (error IS NULL OR (error = btrim(error) AND length(error) BETWEEN 1 AND 600)),
  CONSTRAINT books_restore_drills_finished CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT books_restore_drills_passed CHECK (
    status <> 'passed' OR (
      table_count IS NOT NULL AND row_count IS NOT NULL AND entry_count IS NOT NULL AND line_count IS NOT NULL
      AND link_count IS NOT NULL AND error IS NULL
    )
  ),
  CONSTRAINT books_restore_drills_failed CHECK (status <> 'failed' OR error IS NOT NULL),
  CONSTRAINT books_restore_drills_who CHECK (how = 'by_hand' OR (asked_by IS NULL AND asked_by_name IS NULL))
);
-- One drill runs at a time.
CREATE UNIQUE INDEX IF NOT EXISTS books_restore_drills_one_running ON books_restore_drills ((true)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_books_restore_drills_started ON books_restore_drills (started_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_books_restore_drills_backup ON books_restore_drills (backup_id, started_at DESC);

-- A drill's record changes only while it runs, and stays.
CREATE OR REPLACE FUNCTION public.books_restore_drills_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'books: a restore drill''s record stays';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'books: a finished restore drill''s record doesn''t change';
  END IF;
  IF NEW.id <> OLD.id OR NEW.backup_id <> OLD.backup_id OR NEW.how <> OLD.how
     OR NEW.asked_by IS DISTINCT FROM OLD.asked_by OR NEW.asked_by_name IS DISTINCT FROM OLD.asked_by_name
     OR NEW.started_at <> OLD.started_at OR NEW.migration IS DISTINCT FROM OLD.migration THEN
    RAISE EXCEPTION 'books: only how a restore drill finished is written to its record';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS books_restore_drills_guard ON books_restore_drills;
CREATE TRIGGER books_restore_drills_guard BEFORE UPDATE OR DELETE ON books_restore_drills
  FOR EACH ROW EXECUTE FUNCTION public.books_restore_drills_guard();
DROP TRIGGER IF EXISTS books_restore_drills_truncate_guard ON books_restore_drills;
CREATE TRIGGER books_restore_drills_truncate_guard BEFORE TRUNCATE ON books_restore_drills
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();

-- ── Starting one ───────────────────────────────────────────────────────────

-- Starts a restore drill. p: { how: 'nightly' | 'by_hand', by?, by_name?,
-- backup?: books_backups.id }. Without a backup it takes the newest one made.
-- Returns { state: 'running', id, started_at, how, backup_id } when one is
-- already running; { state: 'none' } when no backup has been made yet;
-- { state: 'drilled', id, backup_id } when the nightly one finds the newest
-- backup has already passed a drill; or { state: 'started', id, started_at,
-- migration, backup: { id, started_at, file_path, file_bytes, file_sha256,
-- migration, tables, rows, entries, lines } }.
CREATE OR REPLACE FUNCTION public.books_restore_drill_begin(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_how TEXT := p->>'how';
  v_by UUID;
  v_by_name TEXT := nullif(btrim(coalesce(p->>'by_name', '')), '');
  v_backup_id UUID := nullif(btrim(coalesce(p->>'backup', '')), '')::uuid;
  v_backup public.books_backups%ROWTYPE;
  v_passed UUID;
  v_row public.books_restore_drills%ROWTYPE;
BEGIN
  IF v_how IS NULL OR v_how NOT IN ('nightly', 'by_hand') THEN
    RAISE EXCEPTION 'books: a restore drill is nightly or by hand';
  END IF;
  IF v_how = 'by_hand' THEN
    v_by := nullif(btrim(coalesce(p->>'by', '')), '')::uuid;
  ELSE
    v_by_name := NULL;
  END IF;

  IF v_backup_id IS NOT NULL THEN
    SELECT * INTO v_backup FROM public.books_backups WHERE id = v_backup_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'books: there''s no such backup';
    END IF;
    IF v_backup.status <> 'made' THEN
      RAISE EXCEPTION 'books: that backup wasn''t made, so there''s nothing to restore';
    END IF;
  ELSE
    SELECT * INTO v_backup FROM public.books_backups WHERE status = 'made' ORDER BY started_at DESC, id DESC LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('state', 'none');
    END IF;
  END IF;

  -- One that stopped without finishing, its server gone, is over.
  UPDATE public.books_restore_drills
  SET status = 'failed', finished_at = now(), error = 'It stopped before it finished.'
  WHERE status = 'running' AND started_at < now() - INTERVAL '10 minutes';

  SELECT * INTO v_row FROM public.books_restore_drills WHERE status = 'running' ORDER BY started_at LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'running', 'id', v_row.id, 'started_at', v_row.started_at, 'how', v_row.how, 'backup_id', v_row.backup_id);
  END IF;

  -- The nightly drill restores each backup once it has passed; a failed one is tried again.
  IF v_how = 'nightly' THEN
    SELECT d.id INTO v_passed FROM public.books_restore_drills d
    WHERE d.backup_id = v_backup.id AND d.status = 'passed'
    ORDER BY d.started_at DESC, d.id DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('state', 'drilled', 'id', v_passed, 'backup_id', v_backup.id);
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.books_restore_drills (backup_id, how, asked_by, asked_by_name, migration)
    VALUES (v_backup.id, v_how, v_by, v_by_name, v_backup.migration)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- Another began at the same moment.
    SELECT * INTO v_row FROM public.books_restore_drills WHERE status = 'running' ORDER BY started_at LIMIT 1;
    RETURN jsonb_build_object('state', 'running', 'id', v_row.id, 'started_at', v_row.started_at, 'how', v_row.how, 'backup_id', v_row.backup_id);
  END;

  RETURN jsonb_build_object(
    'state', 'started',
    'id', v_row.id,
    'started_at', v_row.started_at,
    'migration', v_row.migration,
    'backup', jsonb_build_object(
      'id', v_backup.id,
      'started_at', v_backup.started_at,
      'file_path', v_backup.file_path,
      'file_bytes', v_backup.file_bytes,
      'file_sha256', v_backup.file_sha256,
      'migration', v_backup.migration,
      'tables', v_backup.table_count,
      'rows', v_backup.row_count,
      'entries', v_backup.entry_count,
      'lines', v_backup.line_count
    )
  );
END;
$$;

-- ── Finishing one ──────────────────────────────────────────────────────────

-- Writes how a running drill went. p: { id, status: 'passed' | 'failed',
-- tables?, rows?, entries?, lines?, links?, error? }. Returns { state:
-- 'finished', id, status, finished_at }, or { state: 'gone' } when it isn't
-- running any more (marked failed after stopping, say).
CREATE OR REPLACE FUNCTION public.books_restore_drill_finish(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := nullif(btrim(coalesce(p->>'id', '')), '')::uuid;
  v_status TEXT := p->>'status';
  v_error TEXT := btrim(left(nullif(btrim(coalesce(p->>'error', '')), ''), 600));
  v_row public.books_restore_drills%ROWTYPE;
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'books: which restore drill finished?';
  END IF;
  IF v_status IS NULL OR v_status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'books: a restore drill finishes passed or failed';
  END IF;

  UPDATE public.books_restore_drills SET
    status = v_status,
    finished_at = now(),
    table_count = nullif(p->>'tables', '')::int,
    row_count = nullif(p->>'rows', '')::bigint,
    entry_count = nullif(p->>'entries', '')::bigint,
    line_count = nullif(p->>'lines', '')::bigint,
    link_count = nullif(p->>'links', '')::int,
    error = v_error
  WHERE id = v_id AND status = 'running'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;

  RETURN jsonb_build_object('state', 'finished', 'id', v_row.id, 'status', v_row.status, 'finished_at', v_row.finished_at);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE public.books_restore_drills ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.books_restore_drills FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.books_restore_drill_begin(jsonb)',
    'public.books_restore_drill_finish(jsonb)',
    'public.books_restore_drills_guard()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE books_restore_drills IS 'Migration 507: one row per restore drill of a backup of FleetSuite''s books (Books → Backups, src/lib/books/restore-drill.ts): the backup restored into a scratch database built from FleetSuite''s migrations, nightly or by hand and who asked, when it ran, passed or failed and why, and what came back: tables, rows, journal entries and lines, and the links between tables checked. Changes only while running; rows stay. Service-role write and read.';
COMMENT ON FUNCTION public.books_restore_drill_begin(jsonb) IS 'Migration 507: starts a restore drill of a made backup (the newest when none is named), one at a time (one stopped for ten minutes is marked failed); the nightly one skips a backup that already passed. Hands back the backup''s file, size and SHA-256. Service role only.';
COMMENT ON FUNCTION public.books_restore_drill_finish(jsonb) IS 'Migration 507: writes how a running restore drill went: passed, with what came back, or failed and why. Service role only.';
