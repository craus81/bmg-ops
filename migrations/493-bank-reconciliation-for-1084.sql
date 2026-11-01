-- Migration 493: FleetSuite's own books, part 62 — 1084 Cool Springs' bank
-- reconciliation, statement by statement.
--
-- The NetSuite Exit Checklist's "1084's monthly entries", second slice
-- (src/lib/books/bank-reconciliation.ts, /api/admin/books/bank-reconciliation,
-- page /admin/books/bank-reconciliation, docs/books.md "1084's bank
-- reconciliation"): each month's bank statement held against 1084's books,
-- every entry on its bank account ticked as it clears the bank, until the
-- statement's starting balance and what cleared come to its ending balance.
--
--   * bank_rec_starts, one row per company and bank account: where
--     reconciling starts, the first month whose statement is reconciled here,
--     the bank's balance on the day before that statement starts (the
--     statement before's ending balance), and the entries the books had by
--     then that hadn't cleared the bank yet;
--   * bank_recs, one row per company, bank account and month: the
--     statement's last day and its ending balance, open while it's being
--     ticked and done once what cleared comes to that balance;
--   * bank_rec_ticks: each entry that cleared the bank on a month's
--     statement, once, with what it came to in the books when it was ticked;
--   * bank_rec_events: each month reconciled or undone, by whom, and why it
--     was undone.
--
-- An entry is a document on the account as Reports' detail names it
-- (gl_books_account_documents, migrations 400 and 460): NetSuite's internal
-- id, or 'entry:<id>' for one only FleetSuite's journal has. Months are
-- reconciled in order: only the month after the last one done is ticked,
-- and only the last one done is undone, for a reason, while the month after
-- it has nothing ticked. A month is done only when its starting balance (the
-- month before's ending balance, or where reconciling starts) and what's
-- ticked on it come to its ending balance, to the cent. Where reconciling
-- starts changes only while no month is done, and moving it to another
-- month lets go of what's ticked.
--
-- Nothing here moves money or is sent to NetSuite.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- An entry's name, as gl_books_account_documents gives it: each once.
CREATE OR REPLACE FUNCTION public.bank_rec_docs_ok(p_docs TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(bool_and(d ~ '^([0-9]{1,20}|entry:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'), true)
         AND count(*) = count(DISTINCT d)
  FROM unnest(p_docs) AS d
$$;

-- ── Where reconciling starts ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_rec_starts (
  company TEXT NOT NULL REFERENCES gl_companies(code) ON DELETE RESTRICT,
  -- The bank account, by NetSuite's id.
  account TEXT NOT NULL CHECK (account ~ '^[0-9]+$'),
  -- The first month whose statement is reconciled here.
  first_month DATE NOT NULL CHECK (EXTRACT(DAY FROM first_month) = 1),
  -- The day the bank had balance_cents: the statement before's last day, in the month before.
  as_of DATE NOT NULL,
  balance_cents BIGINT NOT NULL CHECK (balance_cents BETWEEN -10000000000 AND 10000000000),
  -- The entries the books had by as_of that hadn't cleared the bank then.
  outstanding TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(outstanding) <= 500 AND public.bank_rec_docs_ok(outstanding)),
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company, account),
  CONSTRAINT bank_rec_starts_as_of CHECK (public.gl_month_start(as_of) = (first_month - INTERVAL '1 month')::date)
);

-- ── Each month's statement ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_recs (
  company TEXT NOT NULL,
  account TEXT NOT NULL,
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  -- The statement's last day.
  ends_on DATE NOT NULL,
  -- Its ending balance, once typed.
  ending_cents BIGINT CHECK (ending_cents BETWEEN -10000000000 AND 10000000000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  done_at TIMESTAMPTZ,
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company, account, month),
  FOREIGN KEY (company, account) REFERENCES bank_rec_starts (company, account) ON DELETE RESTRICT,
  CONSTRAINT bank_recs_ends_in_month CHECK (public.gl_month_start(ends_on) = month),
  CONSTRAINT bank_recs_done_whole CHECK ((status = 'done') = (done_at IS NOT NULL) AND (status = 'open' OR ending_cents IS NOT NULL))
);

-- Each entry that cleared the bank, on the month's statement it cleared on: once.
CREATE TABLE IF NOT EXISTS bank_rec_ticks (
  company TEXT NOT NULL,
  account TEXT NOT NULL,
  doc TEXT NOT NULL CHECK (public.bank_rec_docs_ok(ARRAY[doc])),
  month DATE NOT NULL,
  -- What it came to in the books when it was ticked, money in (a debit) positive.
  cents BIGINT NOT NULL CHECK (cents <> 0 AND cents BETWEEN -10000000000 AND 10000000000),
  PRIMARY KEY (company, account, doc),
  FOREIGN KEY (company, account, month) REFERENCES bank_recs (company, account, month) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS bank_rec_ticks_month ON bank_rec_ticks (company, account, month);

-- Each month reconciled or undone. Kept when where reconciling starts moves.
CREATE TABLE IF NOT EXISTS bank_rec_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company TEXT NOT NULL REFERENCES gl_companies(code) ON DELETE RESTRICT,
  account TEXT NOT NULL,
  month DATE NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('done', 'undone')),
  reason TEXT CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 300),
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bank_rec_events_reason CHECK ((action = 'undone') = (reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS bank_rec_events_month ON bank_rec_events (company, account, month, created_at);

-- Saves where reconciling a bank account starts. p:
--   { company, account, seen: its updated_at as the page saw it, or null when it isn't saved yet,
--     first_month: 'YYYY-MM-01', as_of, balance_cents, outstanding: [entry, ...], by }
-- Answers { state: 'saved', updated_at, let_go }, let_go the months let go of, with what was ticked on them, because
-- reconciling starts with another month now; 'changed' when it was saved since the page saw it; 'done' when a month
-- is reconciled already, so it stays as it is.
CREATE OR REPLACE FUNCTION public.bank_rec_start_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company TEXT := btrim(p->>'company');
  v_account TEXT := btrim(p->>'account');
  v_first DATE := (p->>'first_month')::date;
  v_as_of DATE := (p->>'as_of')::date;
  v_balance BIGINT := (p->>'balance_cents')::bigint;
  v_outstanding TEXT[] := ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'outstanding', '[]'::jsonb)));
  v_by UUID := nullif(p->>'by', '')::uuid;
  v_row public.bank_rec_starts;
  v_let_go JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_row FROM public.bank_rec_starts WHERE company = v_company AND account = v_account FOR UPDATE;
  IF NOT FOUND THEN
    IF p->>'seen' IS NOT NULL THEN
      RETURN jsonb_build_object('state', 'changed');
    END IF;
    INSERT INTO public.bank_rec_starts (company, account, first_month, as_of, balance_cents, outstanding, updated_by)
    VALUES (v_company, v_account, v_first, v_as_of, v_balance, v_outstanding, v_by)
    ON CONFLICT (company, account) DO NOTHING
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      -- Saved by someone else at the same moment.
      RETURN jsonb_build_object('state', 'changed');
    END IF;
    RETURN jsonb_build_object('state', 'saved', 'updated_at', v_row.updated_at, 'let_go', v_let_go);
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'seen')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_recs WHERE company = v_company AND account = v_account AND status = 'done') THEN
    RETURN jsonb_build_object('state', 'done');
  END IF;

  IF v_first IS DISTINCT FROM v_row.first_month THEN
    -- Nothing is done, so each month saved is open: let go of them and what's ticked on them.
    SELECT coalesce(jsonb_agg(to_char(month, 'YYYY-MM-DD') ORDER BY month), '[]'::jsonb) INTO v_let_go
    FROM public.bank_recs WHERE company = v_company AND account = v_account;
    DELETE FROM public.bank_rec_ticks WHERE company = v_company AND account = v_account;
    DELETE FROM public.bank_recs WHERE company = v_company AND account = v_account;
  END IF;
  UPDATE public.bank_rec_starts
  SET first_month = v_first, as_of = v_as_of, balance_cents = v_balance, outstanding = v_outstanding,
      updated_by = v_by, updated_at = now()
  WHERE company = v_company AND account = v_account
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'saved', 'updated_at', v_row.updated_at, 'let_go', v_let_go);
END;
$$;

-- Saves the statement being reconciled: the month after the last one done, else the month reconciling starts with.
-- p:
--   { company, account, month: 'YYYY-MM-01', seen: its updated_at as the page saw it, or null when it isn't saved yet,
--     ends_on, ending_cents: the statement's ending balance, or null while it isn't typed,
--     ticks: [{ doc, cents }], each entry that cleared on it with what it comes to in the books, finish, by }
-- With finish it's done, once its starting balance and what's ticked come to its ending balance; until then nothing
-- is saved. Answers { state: 'saved' | 'done', updated_at }; 'no_start' when there's nowhere reconciling starts;
-- 'not_next' with the month that's next; 'changed' when it was saved since the page saw it; 'taken' with an entry
-- that cleared on another month; 'no_ending' when it's finished with no ending balance; 'apart' with how far the
-- ending balance is from what cleared.
CREATE OR REPLACE FUNCTION public.bank_rec_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company TEXT := btrim(p->>'company');
  v_account TEXT := btrim(p->>'account');
  v_month DATE := (p->>'month')::date;
  v_ends_on DATE := (p->>'ends_on')::date;
  v_ending BIGINT := (p->>'ending_cents')::bigint;
  v_ticks JSONB := coalesce(p->'ticks', '[]'::jsonb);
  v_finish BOOLEAN := coalesce((p->>'finish')::boolean, false);
  v_by UUID := nullif(p->>'by', '')::uuid;
  v_start public.bank_rec_starts;
  v_row public.bank_recs;
  v_saved BOOLEAN;
  v_next DATE;
  v_taken TEXT;
  v_starting BIGINT;
  v_cleared BIGINT;
BEGIN
  -- One change to an account's reconciling at a time.
  SELECT * INTO v_start FROM public.bank_rec_starts WHERE company = v_company AND account = v_account FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'no_start');
  END IF;
  SELECT coalesce((max(month) + INTERVAL '1 month')::date, v_start.first_month) INTO v_next
  FROM public.bank_recs WHERE company = v_company AND account = v_account AND status = 'done';
  IF v_month IS DISTINCT FROM v_next THEN
    RETURN jsonb_build_object('state', 'not_next', 'next', to_char(v_next, 'YYYY-MM-DD'));
  END IF;
  SELECT * INTO v_row FROM public.bank_recs WHERE company = v_company AND account = v_account AND month = v_month;
  v_saved := FOUND;
  IF (CASE WHEN v_saved THEN v_row.updated_at IS DISTINCT FROM (p->>'seen')::timestamptz ELSE p->>'seen' IS NOT NULL END) THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;
  -- An entry clears once: one that cleared on a month done already isn't this one's.
  SELECT t.doc INTO v_taken
  FROM jsonb_to_recordset(v_ticks) AS x(doc TEXT, cents BIGINT)
  JOIN public.bank_rec_ticks t ON t.company = v_company AND t.account = v_account AND t.doc = x.doc AND t.month <> v_month
  ORDER BY t.doc
  LIMIT 1;
  IF v_taken IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'taken', 'doc', v_taken);
  END IF;

  IF v_finish THEN
    IF v_ending IS NULL THEN
      RETURN jsonb_build_object('state', 'no_ending');
    END IF;
    -- The months done run on from where reconciling starts, so the month before is done when this isn't the first.
    v_starting := CASE WHEN v_month = v_start.first_month THEN v_start.balance_cents
      ELSE (SELECT ending_cents FROM public.bank_recs
            WHERE company = v_company AND account = v_account AND month = (v_month - INTERVAL '1 month')::date) END;
    SELECT coalesce(sum(x.cents), 0) INTO v_cleared FROM jsonb_to_recordset(v_ticks) AS x(doc TEXT, cents BIGINT);
    IF v_ending IS DISTINCT FROM v_starting + v_cleared THEN
      RETURN jsonb_build_object('state', 'apart', 'apart_cents', v_ending - (v_starting + v_cleared));
    END IF;
  END IF;

  IF v_saved THEN
    UPDATE public.bank_recs
    SET ends_on = v_ends_on, ending_cents = v_ending, status = CASE WHEN v_finish THEN 'done' ELSE 'open' END,
        done_by = CASE WHEN v_finish THEN v_by END, done_at = CASE WHEN v_finish THEN now() END,
        updated_by = v_by, updated_at = now()
    WHERE company = v_company AND account = v_account AND month = v_month
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.bank_recs (company, account, month, ends_on, ending_cents, status, done_by, done_at, updated_by)
    VALUES (v_company, v_account, v_month, v_ends_on, v_ending, CASE WHEN v_finish THEN 'done' ELSE 'open' END,
            CASE WHEN v_finish THEN v_by END, CASE WHEN v_finish THEN now() END, v_by)
    RETURNING * INTO v_row;
  END IF;
  DELETE FROM public.bank_rec_ticks WHERE company = v_company AND account = v_account AND month = v_month;
  INSERT INTO public.bank_rec_ticks (company, account, doc, month, cents)
  SELECT v_company, v_account, x.doc, v_month, x.cents FROM jsonb_to_recordset(v_ticks) AS x(doc TEXT, cents BIGINT);
  IF v_finish THEN
    INSERT INTO public.bank_rec_events (company, account, month, action, actor_id) VALUES (v_company, v_account, v_month, 'done', v_by);
  END IF;
  RETURN jsonb_build_object('state', CASE WHEN v_finish THEN 'done' ELSE 'saved' END, 'updated_at', v_row.updated_at);
END;
$$;

-- Undoes the last month reconciled, for a reason, as the page saw it: it's open again, with what's ticked on it. p:
--   { company, account, month: 'YYYY-MM-01', seen: its updated_at as the page saw it, reason, by }
-- Answers { state: 'undone', updated_at }; 'not_last' when it isn't the last month done; 'changed' when it was saved
-- since the page saw it; 'next_ticked' when the month after it has entries ticked.
CREATE OR REPLACE FUNCTION public.bank_rec_undo(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company TEXT := btrim(p->>'company');
  v_account TEXT := btrim(p->>'account');
  v_month DATE := (p->>'month')::date;
  v_by UUID := nullif(p->>'by', '')::uuid;
  v_row public.bank_recs;
BEGIN
  PERFORM 1 FROM public.bank_rec_starts WHERE company = v_company AND account = v_account FOR UPDATE;
  SELECT * INTO v_row FROM public.bank_recs
  WHERE company = v_company AND account = v_account AND status = 'done'
  ORDER BY month DESC
  LIMIT 1;
  IF NOT FOUND OR v_row.month IS DISTINCT FROM v_month THEN
    RETURN jsonb_build_object('state', 'not_last');
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'seen')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_rec_ticks
             WHERE company = v_company AND account = v_account AND month = (v_month + INTERVAL '1 month')::date) THEN
    RETURN jsonb_build_object('state', 'next_ticked');
  END IF;
  UPDATE public.bank_recs
  SET status = 'open', done_by = NULL, done_at = NULL, updated_by = v_by, updated_at = now()
  WHERE company = v_company AND account = v_account AND month = v_month
  RETURNING * INTO v_row;
  INSERT INTO public.bank_rec_events (company, account, month, action, reason, actor_id)
  VALUES (v_company, v_account, v_month, 'undone', btrim(p->>'reason'), v_by);
  RETURN jsonb_build_object('state', 'undone', 'updated_at', v_row.updated_at);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.bank_rec_starts', 'public.bank_recs', 'public.bank_rec_ticks', 'public.bank_rec_events'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.bank_rec_docs_ok(text[])', 'public.bank_rec_start_save(jsonb)', 'public.bank_rec_save(jsonb)', 'public.bank_rec_undo(jsonb)'
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

COMMENT ON TABLE bank_rec_starts IS 'Migration 493: where reconciling a company''s bank account (by NetSuite''s id) starts: the first month whose statement is reconciled in FleetSuite, the bank''s balance the day before that statement starts, and the entries the books had by then that hadn''t cleared (src/lib/books/bank-reconciliation.ts). Changes only while no month is done. Service-role write and read.';
COMMENT ON TABLE bank_recs IS 'Migration 493: a bank account''s statement for one month: its last day and ending balance, open while it''s being ticked and done once its starting balance and what cleared come to its ending balance. Reconciled in order, undone last first. Moved only by its functions. Service-role write and read.';
COMMENT ON TABLE bank_rec_ticks IS 'Migration 493: each entry on a bank account (as gl_books_account_documents names it) that cleared the bank, on the month''s statement it cleared on, once, with what it came to in the books when it was ticked. Service-role write and read.';
COMMENT ON TABLE bank_rec_events IS 'Migration 493: each bank account month reconciled or undone, by whom, and why it was undone. Service-role write and read.';
COMMENT ON FUNCTION public.bank_rec_docs_ok(text[]) IS 'Migration 493: whether each is an entry''s name as gl_books_account_documents gives it (NetSuite''s id, or entry:<id>), each once. Service role only.';
COMMENT ON FUNCTION public.bank_rec_start_save(jsonb) IS 'Migration 493: saves where reconciling a bank account starts, as the page saw it; stays as it is once a month is done, and moving it to another month lets go of what''s ticked. Service role only.';
COMMENT ON FUNCTION public.bank_rec_save(jsonb) IS 'Migration 493: saves the month being reconciled (the one after the last done) with its statement and what''s ticked, and finishes it once what cleared comes to its ending balance. Service role only.';
COMMENT ON FUNCTION public.bank_rec_undo(jsonb) IS 'Migration 493: undoes the last month reconciled, for a reason, while the month after it has nothing ticked. Service role only.';
