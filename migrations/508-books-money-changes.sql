-- Migration 508: FleetSuite's own books, part 86 — the change history on the
-- money tables.
--
-- The NetSuite Exit Checklist's "Controls" (thread "Replacing NetSuite with
-- FleetSuite", building every piece since 2026-10-31). FleetSuite already
-- asks a second person before money goes out (payment runs, typed journal
-- entries, a vendor's bank numbers, inventory adjustments) and records each
-- step in its own columns and audit log. What it couldn't say was what a
-- record looked like before someone changed it, or that a change was made
-- around FleetSuite altogether: straight in the database, from Supabase's
-- dashboard or a SQL window, where none of FleetSuite's checks run. This adds:
--   * books_money_changes, one row for each change to a row of the books:
--     the table, the row's key and a few columns that name it, what changed
--     from what to what, how it was made and, where FleetSuite knows, who
--     made it. A locked column (a vendor's bank account, BMG's offset
--     account, an ACH file) is named but its value is never copied. Rows
--     stay; the only thing ever written to one afterwards is when the super
--     admins were told about it;
--   * books_change_via(), how the change in hand is being made:
--       - 'server'    FleetSuite's server, with its service key;
--       - 'screen'    a browser, signed in as a person, talking to the
--                     database without FleetSuite's server in between;
--       - 'migration' a FleetSuite update (scripts/migrate.mjs says which);
--       - 'database'  anything else: straight in the database;
--   * books_money_change(), the trigger that writes the row. It's on:
--       - every row of the money settings and of the money documents people
--         make, approve and send (the switches, the companies, the chart,
--         the months and years, paying vendors, bank numbers, the ACH files,
--         payments and deposits, journal entries, credits and fixes, card
--         charges, sales tax, own numbers, 1084's rent and mortgage, bank
--         reconciliations, stock adjustments, transfers and counts), however
--         it's made;
--       - every other table of the books (the journal, NetSuite's copies,
--         FleetSuite's own copies, the logs), for a change made outside
--         FleetSuite (via 'database' or 'screen') only: FleetSuite writes
--         those itself, many rows at a time, and records each step in them;
--   * books_outside_changes() and books_outside_changes_told(p), which the
--     daily books check uses to tell the super admins about changes made
--     outside FleetSuite, once each.
--
-- The person: a browser's sign-in when it came from one; otherwise, for
-- FleetSuite's server, the person the change itself stamped on the row (a
-- column like approved_by set with its approved_at), the latest when it
-- stamped several; nobody for a change made in the database or by an update.
-- A row whose only change is its updated_at isn't recorded.
--
-- Someone with the database's owner password can still switch a trigger off;
-- the history records every change made any other way. Restoring a backup
-- loads with the triggers off (docs/books.md "Backups"), so it adds nothing
-- here. Nothing goes to NetSuite. Writer and reader: the service role only.

-- ── The history ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS books_money_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  table_name TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  -- The row's primary key, column by column.
  row_key JSONB NOT NULL,
  -- The row's own columns that name it (a vendor, a company, a month), as they were after the change.
  row_name JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Column by column: { from?, to? }, from left out on an insert and to on a delete; { hidden: true } for a locked
  -- column, with from or to null when it was empty before or is emptied.
  changed JSONB NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('screen', 'server', 'database', 'migration')),
  -- profiles.id of who made it, where FleetSuite knows; kept without a foreign key, as the other books records keep people.
  actor UUID,
  -- The database login that made it: authenticator for FleetSuite and browsers, postgres for the dashboard and updates.
  db_login TEXT NOT NULL,
  -- What the database was told the program was, for a change made straight in it.
  db_app TEXT,
  -- The update's file, for a change a FleetSuite update made.
  migration TEXT,
  -- The database transaction, so changes made together read together, and the daily check marks told only those it saw.
  tx BIGINT NOT NULL,
  told_at TIMESTAMPTZ,
  CONSTRAINT books_money_changes_told CHECK (told_at IS NULL OR via IN ('screen', 'database'))
);
CREATE INDEX IF NOT EXISTS idx_books_money_changes_table ON books_money_changes (table_name, id DESC);
CREATE INDEX IF NOT EXISTS idx_books_money_changes_via ON books_money_changes (via, id DESC);
CREATE INDEX IF NOT EXISTS idx_books_money_changes_actor ON books_money_changes (actor, id DESC) WHERE actor IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_books_money_changes_at ON books_money_changes (at);
CREATE INDEX IF NOT EXISTS idx_books_money_changes_untold ON books_money_changes (id)
  WHERE via IN ('screen', 'database') AND told_at IS NULL;

-- A change's record stays as it was written; only when it was told about is added, once.
CREATE OR REPLACE FUNCTION public.books_money_changes_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'books: the change history stays';
  END IF;
  IF OLD.told_at IS NOT NULL OR NEW.told_at IS NULL OR (to_jsonb(NEW) - 'told_at') <> (to_jsonb(OLD) - 'told_at') THEN
    RAISE EXCEPTION 'books: a change''s record doesn''t change; only when it was told about is written to it, once';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS books_money_changes_guard ON books_money_changes;
CREATE TRIGGER books_money_changes_guard BEFORE UPDATE OR DELETE ON books_money_changes
  FOR EACH ROW EXECUTE FUNCTION public.books_money_changes_guard();
DROP TRIGGER IF EXISTS books_money_changes_truncate_guard ON books_money_changes;
CREATE TRIGGER books_money_changes_truncate_guard BEFORE TRUNCATE ON books_money_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();

-- ── How a change is made ───────────────────────────────────────────────────

-- PostgREST hands every request's sign-in to the database as
-- request.jwt.claims (and older versions as request.jwt.claim.role), as
-- Supabase's own auth.role() reads it; a connection straight to the database
-- has none. scripts/migrate.mjs sets fleetsuite.via to 'migration <file>'
-- for each update it runs. Plain SQL, so a trigger's WHEN takes it inline;
-- callable by whoever writes, since a WHEN runs as them.
CREATE OR REPLACE FUNCTION public.books_change_via()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN pg_catalog.current_setting('fleetsuite.via', true) LIKE 'migration%' THEN 'migration'
    ELSE CASE coalesce(
        nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
        nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
      )
      WHEN 'service_role' THEN 'server'
      WHEN 'authenticated' THEN 'screen'
      WHEN 'anon' THEN 'screen'
      ELSE 'database'
    END
  END
$$;

-- ── Writing a change down ──────────────────────────────────────────────────

-- AFTER INSERT OR UPDATE OR DELETE, for each row. TG_ARGV: [0] the primary
-- key's columns, [1] the columns that name a row (either comma-separated).
-- Columns ending _locked or _seal are named, never copied.
CREATE OR REPLACE FUNCTION public.books_money_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old JSONB;
  v_new JSONB;
  v_row JSONB;
  v_via TEXT := public.books_change_via();
  v_changed JSONB := '{}'::jsonb;
  v_item JSONB;
  v_key JSONB := '{}'::jsonb;
  v_name JSONB := '{}'::jsonb;
  v_col TEXT;
  v_at_col TEXT;
  v_sub TEXT;
  v_actor UUID;
  v_actor_at TEXT;
  v_setting TEXT := nullif(pg_catalog.current_setting('fleetsuite.via', true), '');
  v_uuid CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := to_jsonb(NEW);
  END IF;
  v_row := coalesce(v_new, v_old);

  FOR v_col IN SELECT k FROM jsonb_object_keys(v_row) AS k ORDER BY k LOOP
    -- The row's own times; the change has its own.
    CONTINUE WHEN v_col IN ('created_at', 'updated_at');
    IF TG_OP = 'UPDATE' THEN
      CONTINUE WHEN (v_old -> v_col) = (v_new -> v_col);
    ELSE
      CONTINUE WHEN jsonb_typeof(v_row -> v_col) = 'null';
    END IF;
    IF v_col LIKE '%\_locked' OR v_col LIKE '%\_seal' THEN
      v_item := jsonb_build_object('hidden', true);
      IF TG_OP = 'UPDATE' AND jsonb_typeof(v_old -> v_col) = 'null' THEN
        v_item := v_item || jsonb_build_object('from', NULL::jsonb);
      END IF;
      IF TG_OP = 'UPDATE' AND jsonb_typeof(v_new -> v_col) = 'null' THEN
        v_item := v_item || jsonb_build_object('to', NULL::jsonb);
      END IF;
    ELSE
      v_item := '{}'::jsonb;
      IF TG_OP <> 'INSERT' THEN
        v_item := v_item || jsonb_build_object('from', v_old -> v_col);
      END IF;
      IF TG_OP <> 'DELETE' THEN
        v_item := v_item || jsonb_build_object('to', v_new -> v_col);
      END IF;
    END IF;
    v_changed := v_changed || jsonb_build_object(v_col, v_item);
  END LOOP;
  IF v_changed = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  FOREACH v_col IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
    v_key := v_key || jsonb_build_object(v_col, v_row -> v_col);
  END LOOP;
  IF TG_NARGS > 1 AND TG_ARGV[1] <> '' THEN
    FOREACH v_col IN ARRAY string_to_array(TG_ARGV[1], ',') LOOP
      IF v_row ? v_col AND jsonb_typeof(v_row -> v_col) <> 'null' THEN
        v_name := v_name || jsonb_build_object(v_col, v_row -> v_col);
      END IF;
    END LOOP;
  END IF;

  IF v_via = 'screen' THEN
    v_sub := coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    );
    IF v_sub ~ v_uuid THEN
      v_actor := v_sub::uuid;
    END IF;
  ELSIF v_via = 'server' AND TG_OP <> 'DELETE' THEN
    -- Who this write stamped on the row: an x_by it set, or set again with its x_at.
    FOR v_col IN SELECT k FROM jsonb_object_keys(v_new) AS k WHERE k LIKE '%\_by' ORDER BY k LOOP
      CONTINUE WHEN NOT coalesce((v_new ->> v_col) ~ v_uuid, false);
      v_at_col := left(v_col, -3) || '_at';
      IF TG_OP = 'UPDATE' THEN
        CONTINUE WHEN (v_old -> v_col) = (v_new -> v_col)
          AND (NOT (v_new ? v_at_col) OR (v_old -> v_at_col) = (v_new -> v_at_col));
      END IF;
      IF v_actor IS NULL OR coalesce(v_new ->> v_at_col, '') > coalesce(v_actor_at, '') THEN
        v_actor := (v_new ->> v_col)::uuid;
        v_actor_at := v_new ->> v_at_col;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.books_money_changes (table_name, op, row_key, row_name, changed, via, actor, db_login, db_app, migration, tx)
  VALUES (
    TG_TABLE_NAME,
    lower(TG_OP),
    v_key,
    v_name,
    v_changed,
    v_via,
    v_actor,
    session_user,
    CASE WHEN v_via = 'database' THEN left(nullif(btrim(pg_catalog.current_setting('application_name', true)), ''), 100) END,
    CASE WHEN v_via = 'migration' THEN left(nullif(btrim(regexp_replace(v_setting, '^migration', '')), ''), 200) END,
    txid_current()
  );
  RETURN NULL;
END;
$$;

-- ── Where it's written down ────────────────────────────────────────────────

-- Every change to the money settings and the money documents, with the
-- columns that name a row; the key is read from each table's primary key.
DO $$
DECLARE
  r RECORD;
  v_key TEXT;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('books_switches', 'piece'),
    ('gl_companies', 'code,name'),
    ('gl_accounts', 'number,name'),
    ('gl_periods', 'company_id,period_start'),
    ('gl_year_closes', 'company_id,year'),
    ('vendor_payment_runs', 'company,bank_account_name,pay_date,total_cents'),
    ('vendor_payment_run_payments', 'vendor_name,method,total_cents'),
    ('vendor_checks', 'company,check_number'),
    ('vendor_check_layouts', 'company,bank_account_netsuite_id'),
    ('vendor_bank_accounts', 'vendor_name,routing_number,account_last4'),
    ('vendor_ach_setups', 'company,bank_account_netsuite_id'),
    ('vendor_ach_files', 'company,file_name,total_cents'),
    ('vendor_ach_file_payments', 'vendor_name,cents'),
    ('received_payments', 'company,customer_name,amount_cents'),
    ('received_deposits', 'company,customer_name,sales_order_number,amount_cents'),
    ('made_bank_deposits', 'company,bank_account_name,deposit_date,total_cents'),
    ('typed_journal_entries', 'company,journal,tran_date,total_cents'),
    ('typed_vendor_credits', 'company,vendor_name,credit_number,total_cents'),
    ('invoice_credit_memos', 'customer_name,invoice_number,total_cents'),
    ('invoice_fixes', 'customer_name,invoice_number'),
    ('bill_fixes', 'vendor_name,bill_number'),
    ('detail_changes', 'record_type,name'),
    ('card_merchant_rules', 'company,merchant_key'),
    ('card_charges', 'company,charge_date,description,cents'),
    ('card_charge_sends', 'company,month,total_cents'),
    ('gl_snapped_bills', 'vendor_name,bill_number,total'),
    ('sales_tax_rates', 'location_id,starts_on'),
    ('sales_tax_returns', 'company,month'),
    ('own_number_series', 'doc_type'),
    ('rent_mortgage_setups', 'company'),
    ('rent_mortgage_months', 'company,month'),
    ('bank_rec_starts', 'company,account'),
    ('bank_recs', 'company,account,month'),
    ('inventory_adjustment_asks', 'item_number,location_id'),
    ('inventory_transfers', 'company,tran_date'),
    ('stock_counts', 'number,location_name')
  ) AS t(tbl, names) LOOP
    SELECT string_agg(a.attname, ',' ORDER BY k.n) INTO v_key
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, n)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE i.indrelid = format('public.%I', r.tbl)::regclass AND i.indisprimary;
    IF v_key IS NULL THEN
      RAISE EXCEPTION 'books: % has no primary key to record its changes by', r.tbl;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS books_money_change ON public.%I', r.tbl);
    EXECUTE format(
      'CREATE TRIGGER books_money_change AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.books_money_change(%L, %L)',
      r.tbl, v_key, r.names
    );
  END LOOP;
END $$;

-- Every other table of the books: a change made outside FleetSuite only.
DO $$
DECLARE
  t TEXT;
  v_key TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gl_period_events', 'gl_entries', 'gl_lines',
    'gl_netsuite_transactions', 'gl_netsuite_lines', 'gl_netsuite_opening', 'gl_netsuite_month_totals', 'gl_netsuite_copy_lock',
    'gl_netsuite_lists', 'gl_netsuite_deposits', 'gl_netsuite_bills', 'gl_netsuite_bill_payments', 'gl_netsuite_spending',
    'gl_netsuite_stock_documents', 'gl_netsuite_stock_lines', 'gl_netsuite_stock_opening', 'gl_netsuite_stock_counts',
    'gl_netsuite_opening_parties', 'gl_netsuite_open_items', 'gl_netsuite_1099_accounts', 'gl_netsuite_1099_reports',
    'gl_own_invoices', 'gl_own_invoice_lines', 'gl_own_fulfillments', 'gl_own_fulfillment_lines', 'gl_mistake_checks',
    'gl_own_bills', 'gl_own_bill_lines', 'gl_own_receipts', 'gl_own_receipt_lines',
    'gl_own_credit_memos', 'gl_own_credit_memo_lines', 'gl_own_vendor_credits', 'gl_own_vendor_credit_lines',
    'card_charge_imports', 'gl_own_journal_entries', 'gl_own_journal_entry_lines',
    'gl_own_invoice_versions', 'gl_own_bill_versions', 'netsuite_sends', 'record_differences',
    'gl_own_payments', 'gl_own_payment_applications', 'gl_own_deposits', 'gl_own_bank_deposits', 'gl_own_bill_payments',
    'bank_rec_ticks', 'bank_rec_events', 'own_numbers', 'own_number_outside_told', 'own_invoice_pdfs',
    'stock_count_lines', 'books_saved_reports', 'gl_year_close_events'
  ] LOOP
    -- NetSuite's stock counts and opening stock have no primary key; each row is one item at a location (migration 401).
    v_key := CASE t
      WHEN 'gl_netsuite_stock_opening' THEN 'company_id,item_id,location_id'
      WHEN 'gl_netsuite_stock_counts' THEN 'item_id,location_id'
    END;
    IF v_key IS NULL THEN
      SELECT string_agg(a.attname, ',' ORDER BY k.n) INTO v_key
      FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, n)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = format('public.%I', t)::regclass AND i.indisprimary;
    END IF;
    IF v_key IS NULL THEN
      RAISE EXCEPTION 'books: % has no primary key to record its changes by', t;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS books_money_change ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER books_money_change AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW WHEN (public.books_change_via() IN (''database'', ''screen'')) '
      'EXECUTE FUNCTION public.books_money_change(%L, %L)',
      t, v_key, ''
    );
  END LOOP;
END $$;

-- ── Telling about changes made outside FleetSuite ──────────────────────────

-- The changes made outside FleetSuite nobody has been told about: { changes,
-- through: the newest one's id, snapshot: what the database had finished when
-- it looked, first_at, last_at, tables: [{ table, changes }], ways: [{ via,
-- login, app, changes }] }, most first.
CREATE OR REPLACE FUNCTION public.books_outside_changes()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH untold AS (
    SELECT id, at, table_name, via, db_login, db_app
    FROM public.books_money_changes
    WHERE via IN ('screen', 'database') AND told_at IS NULL
  )
  SELECT jsonb_build_object(
    'changes', (SELECT count(*) FROM untold),
    'through', (SELECT max(id) FROM untold),
    'snapshot', pg_catalog.pg_current_snapshot()::text,
    'first_at', (SELECT min(at) FROM untold),
    'last_at', (SELECT max(at) FROM untold),
    'tables', coalesce((
      SELECT jsonb_agg(jsonb_build_object('table', t.table_name, 'changes', t.n) ORDER BY t.n DESC, t.table_name)
      FROM (SELECT table_name, count(*) AS n FROM untold GROUP BY table_name) t
    ), '[]'::jsonb),
    'ways', coalesce((
      SELECT jsonb_agg(jsonb_build_object('via', w.via, 'login', w.db_login, 'app', w.db_app, 'changes', w.n)
                       ORDER BY w.n DESC, w.via, w.db_login, w.db_app)
      FROM (SELECT via, db_login, db_app, count(*) AS n FROM untold GROUP BY via, db_login, db_app) w
    ), '[]'::jsonb)
  )
$$;

-- Marks the changes made outside FleetSuite that books_outside_changes() saw
-- (p.through and p.snapshot, as it gave them) as told about: those up to and
-- including the newest it saw whose change had been saved by then, so one
-- still being made while it looked, though numbered lower, is told about at
-- the next look. Returns { told: how many }.
CREATE OR REPLACE FUNCTION public.books_outside_changes_told(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_through BIGINT := nullif(btrim(coalesce(p->>'through', '')), '')::bigint;
  v_seen TEXT := nullif(btrim(coalesce(p->>'snapshot', '')), '');
  v_told INT;
BEGIN
  IF v_through IS NULL THEN
    RAISE EXCEPTION 'books: told about the changes up to which one?';
  END IF;
  IF v_seen IS NULL THEN
    RAISE EXCEPTION 'books: told about the changes seen when?';
  END IF;
  UPDATE public.books_money_changes SET told_at = now()
  WHERE via IN ('screen', 'database') AND told_at IS NULL AND id <= v_through
    AND pg_catalog.pg_visible_in_snapshot(tx::text::pg_catalog.xid8, v_seen::pg_catalog.pg_snapshot);
  GET DIAGNOSTICS v_told = ROW_COUNT;
  RETURN jsonb_build_object('told', v_told);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE public.books_money_changes ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.books_money_changes FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.books_money_change()',
    'public.books_money_changes_guard()',
    'public.books_outside_changes()',
    'public.books_outside_changes_told(jsonb)'
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

COMMENT ON TABLE books_money_changes IS 'Migration 508: one row per change to a row of FleetSuite''s books (Books → Change history, src/lib/books/money-changes.ts): every change to the money settings and documents, and any change to the rest of the books made outside FleetSuite. The table, the row''s key and name, each column from and to (locked columns named, never copied), how it was made (FleetSuite''s server, a browser''s sign-in, a FleetSuite update, or straight in the database), who where FleetSuite knows, the database login and program, and when the super admins were told about one made outside FleetSuite. Rows stay. Service-role write and read.';
COMMENT ON FUNCTION public.books_change_via() IS 'Migration 508: how the change in hand is being made: server (FleetSuite''s service key), screen (a browser''s sign-in), migration (scripts/migrate.mjs) or database (straight in it).';
COMMENT ON FUNCTION public.books_money_change() IS 'Migration 508: the trigger that writes a change to a row of the books into books_money_changes. TG_ARGV: the primary key''s columns, the columns that name a row.';
COMMENT ON FUNCTION public.books_outside_changes() IS 'Migration 508: the changes made outside FleetSuite nobody has been told about, counted by table and by how. Service role only.';
COMMENT ON FUNCTION public.books_outside_changes_told(jsonb) IS 'Migration 508: marks the changes made outside FleetSuite up to one told about. Service role only.';
