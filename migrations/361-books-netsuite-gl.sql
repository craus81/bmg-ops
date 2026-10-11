-- Migration 361: FleetSuite's own books, part 3 — NetSuite's general ledger
-- from 2025, copied and checked month by month.
--
-- Owner decision 2026-10-11 (thread "Replacing NetSuite with FleetSuite"):
-- copy NetSuite's history from January 1, 2025, when NetSuite became BMG's
-- real books, down to every GL line, for BMG and 1084. Each company starts
-- from one entry equal to NetSuite's balances before 2025, so the 2024
-- entries that didn't reflect real activity stay out as transactions. The
-- copy is kept current every two hours and checked against NetSuite's own
-- totals for every account and month.
--
-- The copy lives beside the journal, not in it. It follows NetSuite: an
-- edit there replaces the copied lines, and a delete removes them, while a
-- posted gl_entries row never changes. It keeps following NetSuite through
-- 2027, next to what FleetSuite posts itself, so the two can be compared,
-- and FleetSuite's opening balances on the day its books go live come from
-- it. Like the journal before go-live, it can be emptied and copied again.
--
-- src/lib/books/netsuite-gl.ts is the only writer. It works a month at a
-- time: read NetSuite's lines for the month, hand them over in pages
-- (gl_netsuite_apply), then drop what NetSuite no longer has in that month
-- (gl_netsuite_finish_month). Which months need it comes from comparing
-- NetSuite's totals (gl_netsuite_store_totals) with the copy's.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_netsuite_transactions (
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  tran_type TEXT NOT NULL,
  tranid TEXT,
  trandate DATE NOT NULL,
  posting_month DATE NOT NULL CHECK (EXTRACT(DAY FROM posting_month) = 1),
  posting_period_id TEXT,
  content_hash TEXT NOT NULL,
  sweep TEXT NOT NULL,
  copied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_transactions_month ON gl_netsuite_transactions(posting_month);

CREATE TABLE IF NOT EXISTS gl_netsuite_lines (
  transaction_id TEXT NOT NULL REFERENCES gl_netsuite_transactions(netsuite_id) ON DELETE CASCADE,
  line_id TEXT NOT NULL CHECK (line_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_account_id TEXT NOT NULL CHECK (netsuite_account_id ~ '^[0-9]+$'),
  posting_month DATE NOT NULL,
  trandate DATE NOT NULL,
  debit NUMERIC(16,2) NOT NULL DEFAULT 0,
  credit NUMERIC(16,2) NOT NULL DEFAULT 0,
  memo TEXT,
  entity_id TEXT,
  location_id TEXT,
  department_id TEXT,
  class_id TEXT,
  PRIMARY KEY (transaction_id, line_id)
);
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_lines_totals
  ON gl_netsuite_lines(company_id, netsuite_account_id, posting_month) INCLUDE (debit, credit);

CREATE TABLE IF NOT EXISTS gl_netsuite_opening (
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_account_id TEXT NOT NULL CHECK (netsuite_account_id ~ '^[0-9]+$'),
  debit NUMERIC(18,2) NOT NULL,
  credit NUMERIC(18,2) NOT NULL,
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  PRIMARY KEY (company_id, netsuite_account_id)
);

CREATE TABLE IF NOT EXISTS gl_netsuite_month_totals (
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_account_id TEXT NOT NULL CHECK (netsuite_account_id ~ '^[0-9]+$'),
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  debit NUMERIC(18,2) NOT NULL,
  credit NUMERIC(18,2) NOT NULL,
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  PRIMARY KEY (company_id, netsuite_account_id, month)
);

CREATE TABLE IF NOT EXISTS gl_netsuite_copy_lock (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  holder TEXT,
  held_until TIMESTAMPTZ NOT NULL DEFAULT '-infinity'
);
INSERT INTO gl_netsuite_copy_lock (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ── Functions the server calls ─────────────────────────────────────────────

-- Applies one page of a month's copy. p:
--   { sweep: '<token of this pass over the month>',
--     transactions: [{ netsuite_id, tran_type, tranid?, trandate: 'YYYY-MM-DD',
--                      posting_month: 'YYYY-MM-01', posting_period_id?,
--                      lines: [{ line_id, company: 'BMG', netsuite_account_id,
--                                debit, credit, memo?, entity_id?, location_id?,
--                                department_id?, class_id? }] }] }
-- A transaction whose content matches what's stored is only marked seen by
-- this sweep; otherwise its row is replaced and its lines rewritten. The
-- caller sends every field of every line, in line order, so the same
-- content always hashes the same.
CREATE OR REPLACE FUNCTION public.gl_netsuite_apply(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_sweep TEXT := nullif(btrim(p->>'sweep'), '');
  v_companies JSONB;
  v_txn JSONB;
  v_line JSONB;
  v_id TEXT;
  v_hash TEXT;
  v_stored TEXT;
  v_company UUID;
  v_debit NUMERIC;
  v_credit NUMERIC;
  v_received INTEGER := 0;
  v_replaced INTEGER := 0;
  v_unchanged INTEGER := 0;
  v_lines INTEGER := 0;
BEGIN
  IF v_sweep IS NULL THEN
    RAISE EXCEPTION 'gl: sweep is required';
  END IF;
  IF jsonb_typeof(p->'transactions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: transactions must be a list';
  END IF;
  SELECT coalesce(jsonb_object_agg(code, id), '{}'::jsonb) INTO v_companies FROM public.gl_companies;

  FOR v_txn IN SELECT value FROM jsonb_array_elements(p->'transactions') LOOP
    v_received := v_received + 1;
    v_id := v_txn->>'netsuite_id';
    IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'gl: bad NetSuite transaction id %', v_id;
    END IF;
    IF coalesce(v_txn->>'trandate', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'gl: NetSuite transaction % has no date', v_id;
    END IF;
    IF coalesce(v_txn->>'posting_month', '') !~ '^\d{4}-\d{2}-01$' THEN
      RAISE EXCEPTION 'gl: NetSuite transaction % has no posting month', v_id;
    END IF;
    IF coalesce(btrim(v_txn->>'tran_type'), '') = '' THEN
      RAISE EXCEPTION 'gl: NetSuite transaction % has no type', v_id;
    END IF;
    IF jsonb_typeof(v_txn->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(v_txn->'lines') = 0 THEN
      RAISE EXCEPTION 'gl: NetSuite transaction % has no lines', v_id;
    END IF;

    v_hash := md5(v_txn::text);
    SELECT content_hash INTO v_stored FROM public.gl_netsuite_transactions WHERE netsuite_id = v_id FOR UPDATE;
    IF FOUND AND v_stored = v_hash THEN
      UPDATE public.gl_netsuite_transactions SET sweep = v_sweep, seen_at = now() WHERE netsuite_id = v_id;
      v_unchanged := v_unchanged + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.gl_netsuite_transactions (
      netsuite_id, tran_type, tranid, trandate, posting_month, posting_period_id, content_hash, sweep, copied_at, seen_at
    ) VALUES (
      v_id, v_txn->>'tran_type', nullif(v_txn->>'tranid', ''), (v_txn->>'trandate')::date,
      (v_txn->>'posting_month')::date, nullif(v_txn->>'posting_period_id', ''), v_hash, v_sweep, now(), now()
    )
    ON CONFLICT (netsuite_id) DO UPDATE SET
      tran_type = EXCLUDED.tran_type,
      tranid = EXCLUDED.tranid,
      trandate = EXCLUDED.trandate,
      posting_month = EXCLUDED.posting_month,
      posting_period_id = EXCLUDED.posting_period_id,
      content_hash = EXCLUDED.content_hash,
      sweep = EXCLUDED.sweep,
      copied_at = now(),
      seen_at = now();

    DELETE FROM public.gl_netsuite_lines WHERE transaction_id = v_id;
    FOR v_line IN SELECT value FROM jsonb_array_elements(v_txn->'lines') LOOP
      v_company := (v_companies->>(v_line->>'company'))::uuid;
      IF v_company IS NULL THEN
        RAISE EXCEPTION 'gl: unknown company % on NetSuite transaction %', v_line->>'company', v_id;
      END IF;
      v_debit := coalesce(nullif(v_line->>'debit', '')::numeric, 0);
      v_credit := coalesce(nullif(v_line->>'credit', '')::numeric, 0);
      IF v_debit <> round(v_debit, 2) OR v_credit <> round(v_credit, 2) THEN
        RAISE EXCEPTION 'gl: NetSuite transaction % line % has more than two decimal places', v_id, v_line->>'line_id';
      END IF;
      INSERT INTO public.gl_netsuite_lines (
        transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit,
        memo, entity_id, location_id, department_id, class_id
      ) VALUES (
        v_id, v_line->>'line_id', v_company, v_line->>'netsuite_account_id',
        (v_txn->>'posting_month')::date, (v_txn->>'trandate')::date, v_debit, v_credit,
        nullif(v_line->>'memo', ''), nullif(v_line->>'entity_id', ''), nullif(v_line->>'location_id', ''),
        nullif(v_line->>'department_id', ''), nullif(v_line->>'class_id', '')
      );
      v_lines := v_lines + 1;
    END LOOP;
    v_replaced := v_replaced + 1;
  END LOOP;

  RETURN jsonb_build_object('received', v_received, 'replaced', v_replaced, 'unchanged', v_unchanged, 'lines', v_lines);
END;
$$;

-- Ends a pass over one month: every copied transaction in that month the
-- pass didn't see is gone from NetSuite (deleted, or moved to another
-- month, where its own pass copies it again). Returns how many went.
CREATE OR REPLACE FUNCTION public.gl_netsuite_finish_month(p_month DATE, p_sweep TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_removed INTEGER;
BEGIN
  IF p_month IS NULL OR EXTRACT(DAY FROM p_month) <> 1 THEN
    RAISE EXCEPTION 'gl: month must be the first of a month';
  END IF;
  IF coalesce(btrim(p_sweep), '') = '' THEN
    RAISE EXCEPTION 'gl: sweep is required';
  END IF;
  DELETE FROM public.gl_netsuite_transactions
  WHERE posting_month = p_month AND sweep IS DISTINCT FROM p_sweep;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$;

-- Replaces NetSuite's own totals: the balance per account before the copy
-- starts (the starting entry) and the movement per account per month after.
-- p: { opening: [{ company, netsuite_account_id, debit, credit, line_count }],
--      months:  [{ company, netsuite_account_id, month: 'YYYY-MM-01', debit, credit, line_count }] }
-- Refused whole if a row names a company that doesn't exist, or if both
-- lists are empty while totals are stored (a NetSuite read that came back
-- empty is a refusal, not news that the books are blank).
CREATE OR REPLACE FUNCTION public.gl_netsuite_store_totals(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_opening INTEGER;
  v_months INTEGER;
BEGIN
  IF jsonb_typeof(p->'opening') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'months') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: opening and months must be lists';
  END IF;
  IF jsonb_array_length(p->'opening') = 0 AND jsonb_array_length(p->'months') = 0
     AND (EXISTS (SELECT 1 FROM public.gl_netsuite_opening) OR EXISTS (SELECT 1 FROM public.gl_netsuite_month_totals)) THEN
    RAISE EXCEPTION 'gl: NetSuite''s totals came back empty, so the stored ones were kept';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'opening') AS x(company TEXT)
    LEFT JOIN public.gl_companies c ON c.code = x.company WHERE c.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'months') AS x(company TEXT)
    LEFT JOIN public.gl_companies c ON c.code = x.company WHERE c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'gl: NetSuite totals name a company that doesn''t exist';
  END IF;

  DELETE FROM public.gl_netsuite_opening;
  DELETE FROM public.gl_netsuite_month_totals;

  INSERT INTO public.gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
  SELECT c.id, x.netsuite_account_id, x.debit, x.credit, x.line_count
  FROM jsonb_to_recordset(p->'opening') AS x(company TEXT, netsuite_account_id TEXT, debit NUMERIC, credit NUMERIC, line_count INTEGER)
  JOIN public.gl_companies c ON c.code = x.company;
  GET DIAGNOSTICS v_opening = ROW_COUNT;

  INSERT INTO public.gl_netsuite_month_totals (company_id, netsuite_account_id, month, debit, credit, line_count)
  SELECT c.id, x.netsuite_account_id, x.month, x.debit, x.credit, x.line_count
  FROM jsonb_to_recordset(p->'months') AS x(company TEXT, netsuite_account_id TEXT, month DATE, debit NUMERIC, credit NUMERIC, line_count INTEGER)
  JOIN public.gl_companies c ON c.code = x.company;
  GET DIAGNOSTICS v_months = ROW_COUNT;

  RETURN jsonb_build_object('opening', v_opening, 'months', v_months);
END;
$$;

-- Everything the check compares, for one company (or all, when p_company is
-- NULL): NetSuite's starting balances and monthly totals as last stored,
-- and the same monthly totals worked out from the copied lines. Amounts are
-- returned as text so no float ever rounds a cent.
CREATE OR REPLACE FUNCTION public.gl_netsuite_totals(p_company TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH companies AS (
    SELECT id, code FROM public.gl_companies WHERE p_company IS NULL OR code = p_company
  ),
  copied AS (
    SELECT l.company_id, l.netsuite_account_id, l.posting_month,
           sum(l.debit) AS debit, sum(l.credit) AS credit, count(*) AS line_count
    FROM public.gl_netsuite_lines l
    WHERE l.company_id IN (SELECT id FROM companies)
    GROUP BY l.company_id, l.netsuite_account_id, l.posting_month
  )
  SELECT jsonb_build_object(
    'opening', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'company', c.code, 'netsuite_account_id', o.netsuite_account_id,
        'debit', o.debit::text, 'credit', o.credit::text, 'line_count', o.line_count
      ) ORDER BY c.code, o.netsuite_account_id), '[]'::jsonb)
      FROM public.gl_netsuite_opening o JOIN companies c ON c.id = o.company_id
    ),
    'netsuite', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'company', c.code, 'netsuite_account_id', t.netsuite_account_id, 'month', to_char(t.month, 'YYYY-MM-DD'),
        'debit', t.debit::text, 'credit', t.credit::text, 'line_count', t.line_count
      ) ORDER BY c.code, t.netsuite_account_id, t.month), '[]'::jsonb)
      FROM public.gl_netsuite_month_totals t JOIN companies c ON c.id = t.company_id
    ),
    'copied', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'company', c.code, 'netsuite_account_id', x.netsuite_account_id, 'month', to_char(x.posting_month, 'YYYY-MM-DD'),
        'debit', x.debit::text, 'credit', x.credit::text, 'line_count', x.line_count
      ) ORDER BY c.code, x.netsuite_account_id, x.posting_month), '[]'::jsonb)
      FROM copied x JOIN companies c ON c.id = x.company_id
    )
  )
$$;

-- One copy at a time: the two-hourly run and "Copy now" never overlap, so
-- one pass can't drop what another just marked seen. The claim lapses on
-- its own if a run dies holding it.
CREATE OR REPLACE FUNCTION public.gl_netsuite_claim_copy(p_holder TEXT, p_seconds INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(btrim(p_holder), '') = '' THEN
    RAISE EXCEPTION 'gl: holder is required';
  END IF;
  IF p_seconds IS NULL OR p_seconds < 1 OR p_seconds > 900 THEN
    RAISE EXCEPTION 'gl: a claim lasts 1 to 900 seconds';
  END IF;
  INSERT INTO public.gl_netsuite_copy_lock (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
  UPDATE public.gl_netsuite_copy_lock
  SET holder = p_holder, held_until = now() + make_interval(secs => p_seconds)
  WHERE id AND (held_until < now() OR holder = p_holder);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.gl_netsuite_release_copy(p_holder TEXT)
RETURNS VOID
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.gl_netsuite_copy_lock SET holder = NULL, held_until = '-infinity' WHERE id AND holder = p_holder;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gl_netsuite_transactions', 'gl_netsuite_lines', 'gl_netsuite_opening', 'gl_netsuite_month_totals', 'gl_netsuite_copy_lock'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_apply(jsonb)',
    'public.gl_netsuite_finish_month(date, text)',
    'public.gl_netsuite_store_totals(jsonb)',
    'public.gl_netsuite_totals(text)',
    'public.gl_netsuite_claim_copy(text, integer)',
    'public.gl_netsuite_release_copy(text)'
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

COMMENT ON TABLE gl_netsuite_transactions IS 'Migration 361: NetSuite transactions from 2025 on with GL lines for BMG or 1084, copied every two hours by src/lib/books/netsuite-gl.ts. A copy that follows NetSuite (replaced on edit, removed on delete), not FleetSuite''s journal. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_transactions.netsuite_id IS 'NetSuite''s internal id for the transaction.';
COMMENT ON COLUMN gl_netsuite_transactions.tran_type IS 'NetSuite''s transaction type code (''CustInvc'', ''VendBill'', ''Journal'', …).';
COMMENT ON COLUMN gl_netsuite_transactions.posting_month IS 'The month NetSuite posted it to (its accounting period), or the month of its date when the periods can''t be read. Trial balances group by this.';
COMMENT ON COLUMN gl_netsuite_transactions.content_hash IS 'md5 of the transaction and its lines as last copied; an unchanged transaction is not rewritten.';
COMMENT ON COLUMN gl_netsuite_transactions.sweep IS 'The pass over its month that last saw it. A finished pass removes the month''s transactions it didn''t see.';
COMMENT ON COLUMN gl_netsuite_transactions.copied_at IS 'When its lines last changed in the copy.';
COMMENT ON TABLE gl_netsuite_lines IS 'Migration 361: the GL lines (NetSuite TransactionAccountingLine, posting only) of each copied transaction that belong to BMG or 1084. Lines of other subsidiaries are not copied. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_lines.line_id IS 'NetSuite''s transaction line id (0 = the main line).';
COMMENT ON COLUMN gl_netsuite_lines.netsuite_account_id IS 'The NetSuite account posted to; gl_accounts.netsuite_account_id names it in FleetSuite''s chart.';
COMMENT ON COLUMN gl_netsuite_lines.entity_id IS 'NetSuite internal id of the line''s customer, vendor, employee or other name (the transaction''s when the line has none). NULL = none.';
COMMENT ON TABLE gl_netsuite_opening IS 'Migration 361: the starting entry — NetSuite''s total per company and account for everything before the copy starts (2025-01-01), refreshed each run. Service-role write and read.';
COMMENT ON TABLE gl_netsuite_month_totals IS 'Migration 361: NetSuite''s own debits, credits and line counts per company, account and month from 2025, as last read. The trial balance check compares the copy with these. Service-role write and read.';
COMMENT ON TABLE gl_netsuite_copy_lock IS 'Migration 361: one row; who is copying and until when, so two copies never run at once. Service-role write and read.';
