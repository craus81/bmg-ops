-- Migration 506: FleetSuite's own books, part 84 — backups.
--
-- The NetSuite Exit Checklist's "Backups" (thread "Replacing NetSuite with
-- FleetSuite", building every piece since 2026-10-31): a copy of the books
-- every night, kept outside Supabase, that someone could load into an empty
-- database. src/lib/books/backups.ts makes it: each table of the books as a
-- CSV file Postgres's COPY reads back, the journal as an Excel workbook
-- people can open, and a manifest saying what's in it, zipped into BMG's
-- private file storage (docs/books.md "Backups"). This adds:
--   * books_backups, a row for each backup: nightly or by hand and who
--     asked, when it started and finished, made or failed and why, the
--     file's name, size and SHA-256, how many tables, rows, journal entries
--     and lines it holds, and whether its journal checked out against the
--     books. A row only changes while it's running, and stays;
--   * books_backup_begin(p), which starts one: at most one runs at a time,
--     one that stopped without finishing is marked failed after ten minutes,
--     and it hands back the moment the journal is copied as of (a
--     transaction snapshot) with each table's columns, key and parents;
--   * books_backup_page(p), which reads a table in pages by its key, every
--     value as Postgres writes it out, NULL kept apart from an empty string;
--   * books_backup_journal(p), which reads the journal as of that snapshot,
--     entries in order with their lines, so an entry posted while the copy
--     runs is either wholly in it or wholly out of it;
--   * books_backup_trial_balance(p), each account's debits and credits as of
--     the snapshot, which the copy has to add up to;
--   * books_backup_finish(p), which writes how it went.
--
-- Nothing in the books changes, nothing is posted and nothing goes to
-- NetSuite. Writer and reader: the service role only.

-- ── The backups ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS books_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  how TEXT NOT NULL CHECK (how IN ('nightly', 'by_hand')),
  -- profiles.id of who pressed Back up now, kept without a foreign key as the journal keeps who posted.
  asked_by UUID,
  asked_by_name TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'made', 'failed')),
  -- The moment the journal is copied as of: txid_current_snapshot() when it began.
  snapshot TEXT NOT NULL,
  -- The latest migration the database had then, so a restore starts from the same schema.
  migration TEXT,
  -- Under books-backups/ in BMG's file storage.
  file_path TEXT UNIQUE CHECK (file_path IS NULL OR file_path ~ '^[0-9]{4}/fleetsuite-books-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}Z\.zip$'),
  file_bytes BIGINT CHECK (file_bytes IS NULL OR file_bytes > 0),
  file_sha256 TEXT CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  table_count INT CHECK (table_count IS NULL OR table_count >= 0),
  row_count BIGINT CHECK (row_count IS NULL OR row_count >= 0),
  entry_count BIGINT CHECK (entry_count IS NULL OR entry_count >= 0),
  line_count BIGINT CHECK (line_count IS NULL OR line_count >= 0),
  -- The copy's journal adds up to the books' trial balance, entry for entry and line for line.
  checked BOOLEAN,
  error TEXT CHECK (error IS NULL OR (error = btrim(error) AND length(error) BETWEEN 1 AND 600)),
  CONSTRAINT books_backups_finished CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT books_backups_made CHECK (
    status <> 'made' OR (
      file_path IS NOT NULL AND file_bytes IS NOT NULL AND file_sha256 IS NOT NULL
      AND table_count IS NOT NULL AND row_count IS NOT NULL AND entry_count IS NOT NULL AND line_count IS NOT NULL
      AND checked IS TRUE AND error IS NULL
    )
  ),
  CONSTRAINT books_backups_failed CHECK (status <> 'failed' OR error IS NOT NULL),
  CONSTRAINT books_backups_unchecked CHECK (checked IS NOT FALSE OR error IS NOT NULL),
  CONSTRAINT books_backups_file CHECK ((file_path IS NULL) = (file_bytes IS NULL) AND (file_path IS NULL) = (file_sha256 IS NULL)),
  CONSTRAINT books_backups_who CHECK (how = 'by_hand' OR (asked_by IS NULL AND asked_by_name IS NULL))
);
-- One backup runs at a time.
CREATE UNIQUE INDEX IF NOT EXISTS books_backups_one_running ON books_backups ((true)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_books_backups_started ON books_backups (started_at DESC, id);

-- A backup's record changes only while it runs, and stays.
CREATE OR REPLACE FUNCTION public.books_backups_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'books: a backup''s record stays';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'books: a finished backup''s record doesn''t change';
  END IF;
  IF NEW.id <> OLD.id OR NEW.how <> OLD.how
     OR NEW.asked_by IS DISTINCT FROM OLD.asked_by OR NEW.asked_by_name IS DISTINCT FROM OLD.asked_by_name
     OR NEW.started_at <> OLD.started_at OR NEW.snapshot <> OLD.snapshot
     OR NEW.migration IS DISTINCT FROM OLD.migration THEN
    RAISE EXCEPTION 'books: only how a backup finished is written to its record';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS books_backups_guard ON books_backups;
CREATE TRIGGER books_backups_guard BEFORE UPDATE OR DELETE ON books_backups
  FOR EACH ROW EXECUTE FUNCTION public.books_backups_guard();
DROP TRIGGER IF EXISTS books_backups_truncate_guard ON books_backups;
CREATE TRIGGER books_backups_truncate_guard BEFORE TRUNCATE ON books_backups
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();

-- ── Starting one ───────────────────────────────────────────────────────────

-- Starts a backup. p: { how: 'nightly' | 'by_hand', by?, by_name?, tables: [names] }.
-- Returns { state: 'running', id, started_at, how } when one is already
-- running, or { state: 'started', id, started_at, snapshot, migration,
-- tables: [{ table, columns: [{ name, type }], generated, identity, key,
-- parents }] } in the order asked: columns in the table's order without the
-- generated ones, which a restore works out again; key the primary key's
-- columns (none for a table without one); parents the other tables its
-- foreign keys point at.
CREATE OR REPLACE FUNCTION public.books_backup_begin(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_how TEXT := p->>'how';
  v_by UUID;
  v_by_name TEXT := nullif(btrim(coalesce(p->>'by_name', '')), '');
  v_tables JSONB := p->'tables';
  v_bad TEXT;
  v_migration TEXT;
  v_meta JSONB;
  v_row public.books_backups%ROWTYPE;
BEGIN
  IF v_how IS NULL OR v_how NOT IN ('nightly', 'by_hand') THEN
    RAISE EXCEPTION 'books: a backup is nightly or by hand';
  END IF;
  IF v_how = 'by_hand' THEN
    v_by := nullif(btrim(coalesce(p->>'by', '')), '')::uuid;
  ELSE
    v_by_name := NULL;
  END IF;
  IF v_tables IS NULL OR jsonb_typeof(v_tables) <> 'array' OR jsonb_array_length(v_tables) = 0 THEN
    RAISE EXCEPTION 'books: a backup needs the tables it copies';
  END IF;
  SELECT x.name INTO v_bad
  FROM jsonb_array_elements(v_tables) WITH ORDINALITY AS e(value, ord)
  CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(e.value) = 'string' THEN e.value #>> '{}' END AS name) x
  WHERE x.name IS NULL
     OR x.name !~ '^[a-z][a-z0-9_]{0,62}$'
     OR coalesce((SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.' || quote_ident(x.name))), '-') <> 'r'
  ORDER BY e.ord
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'books: % isn''t a table there is to back up', coalesce(v_bad, 'That');
  END IF;
  IF (SELECT count(DISTINCT e.value) <> count(*) FROM jsonb_array_elements(v_tables) AS e(value)) THEN
    RAISE EXCEPTION 'books: a backup names each table once';
  END IF;

  -- One that stopped without finishing, its server gone, is over.
  UPDATE public.books_backups
  SET status = 'failed', finished_at = now(), error = 'It stopped before it finished.'
  WHERE status = 'running' AND started_at < now() - INTERVAL '10 minutes';

  SELECT * INTO v_row FROM public.books_backups WHERE status = 'running' ORDER BY started_at LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'running', 'id', v_row.id, 'started_at', v_row.started_at, 'how', v_row.how);
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT max(filename) FROM public.schema_migrations' INTO v_migration;
  END IF;

  BEGIN
    INSERT INTO public.books_backups (how, asked_by, asked_by_name, snapshot, migration)
    VALUES (v_how, v_by, v_by_name, pg_catalog.txid_current_snapshot()::text, v_migration)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- Another began at the same moment.
    SELECT * INTO v_row FROM public.books_backups WHERE status = 'running' ORDER BY started_at LIMIT 1;
    RETURN jsonb_build_object('state', 'running', 'id', v_row.id, 'started_at', v_row.started_at, 'how', v_row.how);
  END;

  SELECT jsonb_agg(jsonb_build_object(
    'table', t.name,
    'columns', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum), '[]'::jsonb)
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = t.rel AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
    ),
    'generated', (
      SELECT coalesce(jsonb_agg(a.attname ORDER BY a.attnum), '[]'::jsonb)
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = t.rel AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> ''
    ),
    'identity', (
      SELECT coalesce(jsonb_agg(a.attname ORDER BY a.attnum), '[]'::jsonb)
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = t.rel AND a.attnum > 0 AND NOT a.attisdropped AND a.attidentity <> ''
    ),
    'key', (
      SELECT coalesce(jsonb_agg(a.attname ORDER BY k.ord), '[]'::jsonb)
      FROM pg_catalog.pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = t.rel AND i.indisprimary
    ),
    'parents', (
      SELECT coalesce(jsonb_agg(DISTINCT f.relname::text ORDER BY f.relname::text), '[]'::jsonb)
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class f ON f.oid = c.confrelid
      WHERE c.conrelid = t.rel AND c.contype = 'f' AND f.relnamespace = 'public'::regnamespace AND f.oid <> t.rel
    )
  ) ORDER BY t.ord) INTO v_meta
  FROM (
    SELECT e.value #>> '{}' AS name, e.ord, to_regclass('public.' || quote_ident(e.value #>> '{}')) AS rel
    FROM jsonb_array_elements(v_tables) WITH ORDINALITY AS e(value, ord)
  ) t;

  RETURN jsonb_build_object(
    'state', 'started',
    'id', v_row.id,
    'started_at', v_row.started_at,
    'snapshot', v_row.snapshot,
    'migration', v_row.migration,
    'tables', v_meta
  );
END;
$$;

-- ── Reading a table ────────────────────────────────────────────────────────

-- One page of a table in its primary key's order. p: { table, after?: [the
-- last page's key values], limit? (2000, at most 5000) }. Returns { columns,
-- key, rows: [[value or null, ...]], last }: each value as Postgres writes
-- it out, in UTC and ISO dates, which COPY reads back; last is the key to
-- read on from, or null once the table is done. A table without a primary
-- key comes whole in one page, while it has no more than 100,000 rows. The
-- journal is read with books_backup_journal.
CREATE OR REPLACE FUNCTION public.books_backup_page(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
SET timezone = 'UTC'
SET datestyle = 'ISO, YMD'
SET intervalstyle = 'postgres'
AS $$
DECLARE
  v_table TEXT := p->>'table';
  v_rel REGCLASS;
  v_limit INT := least(greatest(coalesce(nullif(p->>'limit', '')::int, 2000), 1), 5000);
  v_after TEXT[];
  v_cols TEXT[];
  v_keys TEXT[];
  v_types TEXT[];
  v_values TEXT;
  v_where TEXT := 'true';
  v_count BIGINT;
  v_rows JSONB;
  v_last JSONB;
  v_n INT;
BEGIN
  IF v_table IS NULL OR v_table !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'books: % isn''t a table there is to back up', coalesce(v_table, 'That');
  END IF;
  IF v_table IN ('gl_entries', 'gl_lines') THEN
    RAISE EXCEPTION 'books: the journal is read with books_backup_journal';
  END IF;
  v_rel := to_regclass('public.' || quote_ident(v_table));
  IF v_rel IS NULL OR (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = v_rel) <> 'r' THEN
    RAISE EXCEPTION 'books: % isn''t a table there is to back up', v_table;
  END IF;
  IF jsonb_typeof(p->'after') = 'array' THEN
    SELECT array_agg(a.value ORDER BY a.ord) INTO v_after
    FROM jsonb_array_elements_text(p->'after') WITH ORDINALITY AS a(value, ord);
  END IF;

  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO v_cols
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = v_rel AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';
  SELECT array_agg(a.attname::text ORDER BY k.ord), array_agg(pg_catalog.format_type(a.atttypid, a.atttypmod) ORDER BY k.ord)
  INTO v_keys, v_types
  FROM pg_catalog.pg_index i
  CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indrelid = v_rel AND i.indisprimary;
  SELECT string_agg(format('t.%I::text', c.name), ', ' ORDER BY c.ord) INTO v_values
  FROM unnest(v_cols) WITH ORDINALITY AS c(name, ord);

  IF v_keys IS NULL THEN
    EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO v_count;
    IF v_count > 100000 THEN
      RAISE EXCEPTION 'books: % has % rows and no key, too many to read at once', v_table, v_count;
    END IF;
    EXECUTE format(
      'SELECT coalesce(jsonb_agg(to_jsonb(r.v) ORDER BY r.v), ''[]''::jsonb) FROM (SELECT ARRAY[%s]::text[] AS v FROM public.%I t) r',
      v_values, v_table
    ) INTO v_rows;
    RETURN jsonb_build_object('columns', to_jsonb(v_cols), 'key', '[]'::jsonb, 'rows', v_rows, 'last', NULL);
  END IF;

  IF v_after IS NOT NULL THEN
    IF cardinality(v_after) <> cardinality(v_keys) THEN
      RAISE EXCEPTION 'books: % is read on from its key''s % values', v_table, cardinality(v_keys);
    END IF;
    SELECT format('(%s) > (%s)',
      string_agg(format('t.%I', k.name), ', ' ORDER BY k.ord),
      string_agg(format('$1[%s]::%s', k.ord, v_types[k.ord]), ', ' ORDER BY k.ord))
    INTO v_where
    FROM unnest(v_keys) WITH ORDINALITY AS k(name, ord);
  END IF;

  -- The page is cut in its own query, by the key's index; the rows and the
  -- key to read on from are put together from it.
  EXECUTE (
    SELECT format(
      'SELECT coalesce(jsonb_agg(to_jsonb(r.v) ORDER BY %s), ''[]''::jsonb), count(*)::int,'
      ' (array_agg(to_jsonb(ARRAY[%s]::text[]) ORDER BY %s))[1]'
      ' FROM (SELECT ARRAY[%s]::text[] AS v, %s FROM public.%I t WHERE %s ORDER BY %s LIMIT %s) r',
      string_agg(format('r.k__%s', k.ord), ', ' ORDER BY k.ord),
      string_agg(format('r.k__%s::text', k.ord), ', ' ORDER BY k.ord),
      string_agg(format('r.k__%s DESC', k.ord), ', ' ORDER BY k.ord),
      v_values,
      string_agg(format('t.%I AS k__%s', k.name, k.ord), ', ' ORDER BY k.ord),
      v_table,
      v_where,
      string_agg(format('t.%I', k.name), ', ' ORDER BY k.ord),
      v_limit
    )
    FROM unnest(v_keys) WITH ORDINALITY AS k(name, ord)
  ) INTO v_rows, v_n, v_last USING v_after;

  RETURN jsonb_build_object(
    'columns', to_jsonb(v_cols),
    'key', to_jsonb(v_keys),
    'rows', v_rows,
    'last', CASE WHEN v_n = v_limit THEN v_last END
  );
END;
$$;

-- ── Reading the journal ────────────────────────────────────────────────────

-- One page of the journal as of a backup's snapshot: the entries posted
-- before it began, in entry number order, each with all its lines. p: {
-- snapshot, after?: the last page's entry number, limit? (1000, at most
-- 5000 entries) }. Returns { entry_columns, line_columns, entries, lines,
-- last }, values written out as books_backup_page writes them; last is the
-- entry number to read on from, or null once the journal is done. Entries
-- and lines never change or go, so the snapshot says exactly which are in.
CREATE OR REPLACE FUNCTION public.books_backup_journal(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
SET timezone = 'UTC'
SET datestyle = 'ISO, YMD'
SET intervalstyle = 'postgres'
AS $$
DECLARE
  v_snapshot pg_catalog.txid_snapshot;
  v_after BIGINT := coalesce(nullif(p->>'after', '')::bigint, 0);
  v_limit INT := least(greatest(coalesce(nullif(p->>'limit', '')::int, 1000), 1), 5000);
  v_entry_cols TEXT[];
  v_line_cols TEXT[];
  v_page JSONB;
BEGIN
  IF nullif(p->>'snapshot', '') IS NULL THEN
    RAISE EXCEPTION 'books: the journal is read as of the backup''s snapshot';
  END IF;
  v_snapshot := (p->>'snapshot')::pg_catalog.txid_snapshot;

  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO v_entry_cols
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.gl_entries'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO v_line_cols
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.gl_lines'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';

  EXECUTE format(
    'WITH page AS ('
    '  SELECT e.id, e.entry_no, ARRAY[%s]::text[] AS v FROM public.gl_entries e'
    '  WHERE e.entry_no > $1 AND pg_catalog.txid_visible_in_snapshot(e.posted_txid, $2)'
    '  ORDER BY e.entry_no LIMIT %s'
    ') SELECT jsonb_build_object('
    '  ''entries'', coalesce((SELECT jsonb_agg(to_jsonb(page.v) ORDER BY page.entry_no) FROM page), ''[]''::jsonb),'
    '  ''lines'', coalesce((SELECT jsonb_agg(to_jsonb(ARRAY[%s]::text[]) ORDER BY page.entry_no, l.line_no)'
    '     FROM page JOIN public.gl_lines l ON l.entry_id = page.id), ''[]''::jsonb),'
    '  ''count'', (SELECT count(*) FROM page),'
    '  ''last'', (SELECT max(page.entry_no) FROM page))',
    (SELECT string_agg(format('e.%I::text', c.name), ', ' ORDER BY c.ord) FROM unnest(v_entry_cols) WITH ORDINALITY AS c(name, ord)),
    v_limit,
    (SELECT string_agg(format('l.%I::text', c.name), ', ' ORDER BY c.ord) FROM unnest(v_line_cols) WITH ORDINALITY AS c(name, ord))
  ) INTO v_page USING v_after, v_snapshot;

  RETURN jsonb_build_object(
    'entry_columns', to_jsonb(v_entry_cols),
    'line_columns', to_jsonb(v_line_cols),
    'entries', v_page->'entries',
    'lines', v_page->'lines',
    'last', CASE WHEN (v_page->>'count')::int = v_limit THEN v_page->'last' END
  );
END;
$$;

-- Each company's and account's debits and credits in the journal as of a
-- backup's snapshot, and how many entries and lines that is. p: { snapshot }.
-- Returns { entries, lines, accounts: [{ company_id, account_id, debit,
-- credit }] }, amounts as text.
CREATE OR REPLACE FUNCTION public.books_backup_trial_balance(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_snapshot pg_catalog.txid_snapshot;
  v_entries BIGINT;
  v_lines BIGINT;
  v_accounts JSONB;
BEGIN
  IF nullif(p->>'snapshot', '') IS NULL THEN
    RAISE EXCEPTION 'books: the trial balance is worked out as of the backup''s snapshot';
  END IF;
  v_snapshot := (p->>'snapshot')::pg_catalog.txid_snapshot;

  SELECT count(*) INTO v_entries
  FROM public.gl_entries e
  WHERE pg_catalog.txid_visible_in_snapshot(e.posted_txid, v_snapshot);

  SELECT coalesce(sum(s.n), 0), coalesce(jsonb_agg(jsonb_build_object(
      'company_id', s.company_id, 'account_id', s.account_id, 'debit', s.debit::text, 'credit', s.credit::text
    ) ORDER BY s.company_id, s.account_id), '[]'::jsonb)
  INTO v_lines, v_accounts
  FROM (
    SELECT l.company_id, l.account_id, count(*) AS n, sum(l.debit) AS debit, sum(l.credit) AS credit
    FROM public.gl_lines l
    JOIN public.gl_entries e ON e.id = l.entry_id
    WHERE pg_catalog.txid_visible_in_snapshot(e.posted_txid, v_snapshot)
    GROUP BY l.company_id, l.account_id
  ) s;

  RETURN jsonb_build_object('entries', v_entries, 'lines', v_lines, 'accounts', v_accounts);
END;
$$;

-- ── Finishing one ──────────────────────────────────────────────────────────

-- Writes how a running backup went. p: { id, status: 'made' | 'failed',
-- file_path?, file_bytes?, file_sha256?, tables?, rows?, entries?, lines?,
-- checked?, error? }. Returns { state: 'finished', id, status, finished_at },
-- or { state: 'gone' } when it isn't running any more (marked failed after
-- stopping, say).
CREATE OR REPLACE FUNCTION public.books_backup_finish(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := nullif(btrim(coalesce(p->>'id', '')), '')::uuid;
  v_status TEXT := p->>'status';
  v_error TEXT := btrim(left(nullif(btrim(coalesce(p->>'error', '')), ''), 600));
  v_row public.books_backups%ROWTYPE;
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'books: which backup finished?';
  END IF;
  IF v_status IS NULL OR v_status NOT IN ('made', 'failed') THEN
    RAISE EXCEPTION 'books: a backup finishes made or failed';
  END IF;

  UPDATE public.books_backups SET
    status = v_status,
    finished_at = now(),
    file_path = nullif(p->>'file_path', ''),
    file_bytes = nullif(p->>'file_bytes', '')::bigint,
    file_sha256 = nullif(p->>'file_sha256', ''),
    table_count = nullif(p->>'tables', '')::int,
    row_count = nullif(p->>'rows', '')::bigint,
    entry_count = nullif(p->>'entries', '')::bigint,
    line_count = nullif(p->>'lines', '')::bigint,
    checked = CASE WHEN jsonb_typeof(p->'checked') = 'boolean' THEN (p->>'checked')::boolean END,
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
  ALTER TABLE public.books_backups ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.books_backups FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.books_backup_begin(jsonb)',
    'public.books_backup_page(jsonb)',
    'public.books_backup_journal(jsonb)',
    'public.books_backup_trial_balance(jsonb)',
    'public.books_backup_finish(jsonb)',
    'public.books_backups_guard()'
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

COMMENT ON TABLE books_backups IS 'Migration 506: one row per backup of FleetSuite''s books (Books → Backups, src/lib/books/backups.ts): nightly or by hand and who asked, when it ran, made or failed and why, the zip''s name under books-backups/ in BMG''s file storage with its size and SHA-256, how many tables, rows, journal entries and lines it holds, and whether its journal added up to the books'' trial balance. Changes only while running; rows stay. Service-role write and read.';
COMMENT ON FUNCTION public.books_backup_begin(jsonb) IS 'Migration 506: starts a backup of the books, one at a time (one stopped for ten minutes is marked failed), and hands back its journal snapshot and each table''s columns, key and parents. Service role only.';
COMMENT ON FUNCTION public.books_backup_page(jsonb) IS 'Migration 506: one page of a table in its primary key''s order, every value as Postgres writes it out (UTC, ISO dates), for a backup. Service role only.';
COMMENT ON FUNCTION public.books_backup_journal(jsonb) IS 'Migration 506: one page of the journal as of a backup''s snapshot, entries in number order with their lines. Service role only.';
COMMENT ON FUNCTION public.books_backup_trial_balance(jsonb) IS 'Migration 506: each company''s and account''s debits and credits as of a backup''s snapshot, which the backup''s copy of the journal has to add up to. Service role only.';
COMMENT ON FUNCTION public.books_backup_finish(jsonb) IS 'Migration 506: writes how a running backup went: made, with its file, counts and check, or failed and why. Service role only.';
