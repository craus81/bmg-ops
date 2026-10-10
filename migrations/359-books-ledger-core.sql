-- Migration 359: FleetSuite's own books, part 1 — the ledger core.
--
-- Owner decisions 2026-10-09/10 (thread "Replacing NetSuite with FleetSuite"):
-- FleetSuite keeps BMG's books itself, side by side with NetSuite through
-- 2027 and alone from 2028-01-01. 1084 Cool Springs LLC, which owns the
-- building, is kept here too as a second company. Built on main, hidden:
-- nothing in the app reads or writes these tables yet.
--
-- This file is the part every later piece stands on: companies, the chart
-- of accounts, monthly periods, and a journal the database itself protects.
-- The ledger_* tables from migration 314 stay what they are — copies of
-- QuickBooks and NetSuite history, refreshed by importers that replace rows
-- wholesale — so the protected journal lives in its own gl_* tables.
--
-- Rules enforced here, not just in screens:
--   * An entry posts only if its debits equal its credits and it has at
--     least two lines (checked when the posting transaction commits).
--   * A posted entry or line is never updated or deleted. A correction is a
--     reversal (gl_reverse_entry) linked to the original, plus a new entry.
--   * Lines can only be added in the same transaction that posts the entry.
--   * A closed month refuses new entries. Closing and reopening are logged
--     in gl_period_events, and reopening needs a reason.
--   * Every line carries its company, copied from the entry, plus what BMG
--     reports by: division, location, customer or vendor, job and item.
--   * A typed ("manual") entry can't touch a control account (AR, AP,
--     inventory); only the documents behind those accounts post there.
--   * The same idempotency key never posts twice, so a retried post is safe.
--   * Until any company's books_live_from is set, the journal and its months
--     may be emptied (gl_reset_journal) to re-run rehearsals. Once a company
--     is live that is refused, its live date can't change, and entries dated
--     before it are refused except opening balances.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- ── Helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_month_start(d DATE)
RETURNS DATE
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$ SELECT d - (EXTRACT(DAY FROM d)::int - 1) $$;

-- ── Companies ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,12}$'),
  name TEXT NOT NULL,
  legal_name TEXT,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  netsuite_subsidiary_id TEXT UNIQUE,
  books_live_from DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO gl_companies (code, name, legal_name, netsuite_subsidiary_id)
VALUES
  ('BMG', 'BMG Fleet Installations', 'BMG Fleet Installations LLC', '2'),
  ('1084', '1084 Cool Springs', '1084 Cool Springs LLC', NULL)
ON CONFLICT (code) DO NOTHING;

-- ── Chart of accounts ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN (
    'bank', 'accounts_receivable', 'other_current_asset', 'fixed_asset', 'other_asset',
    'unbilled_receivable', 'deferred_expense',
    'accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability',
    'deferred_revenue', 'equity',
    'income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense'
  )),
  normal_balance TEXT GENERATED ALWAYS AS (
    CASE WHEN account_type IN (
      'bank', 'accounts_receivable', 'other_current_asset', 'fixed_asset', 'other_asset',
      'unbilled_receivable', 'deferred_expense', 'cost_of_goods_sold', 'expense', 'other_expense'
    ) THEN 'debit' ELSE 'credit' END
  ) STORED,
  statement TEXT GENERATED ALWAYS AS (
    CASE WHEN account_type IN ('income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense')
      THEN 'income_statement' ELSE 'balance_sheet' END
  ) STORED,
  parent_id UUID REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  company_id UUID REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_account_id TEXT UNIQUE,
  is_control BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_number ON gl_accounts(number);

-- ── Periods ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL CHECK (EXTRACT(DAY FROM period_start) = 1),
  period_end DATE GENERATED ALWAYS AS ((period_start + INTERVAL '1 month')::date - 1) STORED,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,
  closed_by UUID,
  closed_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_start)
);

CREATE TABLE IF NOT EXISTS gl_period_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('closed', 'reopened')),
  actor_id UUID,
  actor_name TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_period_events_period ON gl_period_events(period_id, created_at);

-- ── Journal ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_no BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  entry_date DATE NOT NULL,
  period_id UUID NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type ~ '^[a-z][a-z_]{1,39}$'),
  source_id TEXT,
  posting_rule TEXT NOT NULL CHECK (length(btrim(posting_rule)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
  memo TEXT,
  reverses_entry_id UUID UNIQUE REFERENCES gl_entries(id) ON DELETE RESTRICT,
  posted_by UUID,
  posted_by_name TEXT,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_txid BIGINT NOT NULL DEFAULT txid_current()
);
CREATE INDEX IF NOT EXISTS idx_gl_entries_company_date ON gl_entries(company_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_gl_entries_source ON gl_entries(source_type, source_id);

CREATE TABLE IF NOT EXISTS gl_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES gl_entries(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  entry_date DATE NOT NULL,
  account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  debit NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo TEXT,
  division TEXT CHECK (division IN ('upfit', 'graphics', 'shared')),
  location TEXT CHECK (location ~ '^[a-z0-9_]{2,40}$'),
  customer_id UUID,
  vendor_ref TEXT,
  job_ref TEXT,
  item_number TEXT,
  source_line_ref TEXT,
  CONSTRAINT gl_lines_one_side CHECK ((debit > 0) <> (credit > 0)),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_gl_lines_account_date ON gl_lines(account_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_gl_lines_company_date ON gl_lines(company_id, entry_date);

-- ── Triggers: companies and accounts ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_companies_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.books_live_from IS NOT NULL AND NEW.books_live_from IS DISTINCT FROM OLD.books_live_from THEN
    RAISE EXCEPTION 'gl: % went live on %, and that date can''t change', OLD.name, OLD.books_live_from;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gl_companies_guard ON gl_companies;
CREATE TRIGGER gl_companies_guard BEFORE UPDATE ON gl_companies
  FOR EACH ROW EXECUTE FUNCTION public.gl_companies_before_update();

CREATE OR REPLACE FUNCTION public.gl_accounts_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (NEW.account_type IS DISTINCT FROM OLD.account_type OR NEW.company_id IS DISTINCT FROM OLD.company_id)
     AND EXISTS (SELECT 1 FROM public.gl_lines WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'gl: account % (%) has postings, so its type and company can''t change', OLD.number, OLD.name;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gl_accounts_guard ON gl_accounts;
CREATE TRIGGER gl_accounts_guard BEFORE UPDATE ON gl_accounts
  FOR EACH ROW EXECUTE FUNCTION public.gl_accounts_before_update();

-- ── Triggers: periods ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_periods_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.period_start IS DISTINCT FROM OLD.period_start THEN
    RAISE EXCEPTION 'gl: a period''s company and month can''t change';
  END IF;
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    NEW.closed_at := now();
    NEW.closed_by := nullif(current_setting('gl.actor_id', true), '')::uuid;
    NEW.closed_by_name := nullif(current_setting('gl.actor_name', true), '');
  ELSIF NEW.status = 'open' AND OLD.status = 'closed' THEN
    IF coalesce(btrim(current_setting('gl.reason', true)), '') = '' THEN
      RAISE EXCEPTION 'gl: reopening % needs a reason', to_char(OLD.period_start, 'YYYY-MM');
    END IF;
    NEW.closed_at := NULL;
    NEW.closed_by := NULL;
    NEW.closed_by_name := NULL;
  ELSE
    -- Who closed a month and when is only ever set by the close itself.
    NEW.closed_at := OLD.closed_at;
    NEW.closed_by := OLD.closed_by;
    NEW.closed_by_name := OLD.closed_by_name;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gl_periods_guard ON gl_periods;
CREATE TRIGGER gl_periods_guard BEFORE UPDATE ON gl_periods
  FOR EACH ROW EXECUTE FUNCTION public.gl_periods_before_update();

CREATE OR REPLACE FUNCTION public.gl_periods_log_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.gl_period_events (period_id, action, actor_id, actor_name, reason)
    VALUES (
      NEW.id,
      CASE WHEN NEW.status = 'closed' THEN 'closed' ELSE 'reopened' END,
      nullif(current_setting('gl.actor_id', true), '')::uuid,
      nullif(current_setting('gl.actor_name', true), ''),
      nullif(btrim(current_setting('gl.reason', true)), '')
    );
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS gl_periods_log ON gl_periods;
CREATE TRIGGER gl_periods_log AFTER UPDATE OF status ON gl_periods
  FOR EACH ROW EXECUTE FUNCTION public.gl_periods_log_status();

-- ── Triggers: the journal ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_entries_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company public.gl_companies%ROWTYPE;
  v_period public.gl_periods%ROWTYPE;
  v_target public.gl_entries%ROWTYPE;
BEGIN
  SELECT * INTO v_company FROM public.gl_companies WHERE id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: unknown company %', NEW.company_id;
  END IF;
  IF NOT v_company.active THEN
    RAISE EXCEPTION 'gl: % is inactive', v_company.name;
  END IF;
  IF v_company.books_live_from IS NOT NULL AND NEW.entry_date < v_company.books_live_from
     AND NEW.source_type <> 'opening_balance' THEN
    RAISE EXCEPTION 'gl: % is before % went live (%)', NEW.entry_date, v_company.name, v_company.books_live_from;
  END IF;

  -- FOR SHARE holds the month open until this posting commits, so a close
  -- running at the same moment waits instead of slipping in between.
  SELECT * INTO v_period FROM public.gl_periods
  WHERE company_id = NEW.company_id AND period_start = public.gl_month_start(NEW.entry_date)
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: % has no accounting period for %', v_company.name, to_char(NEW.entry_date, 'YYYY-MM');
  END IF;
  IF v_period.status <> 'open' THEN
    RAISE EXCEPTION 'gl: % is closed for %', to_char(NEW.entry_date, 'YYYY-MM'), v_company.name;
  END IF;

  IF (NEW.source_type = 'reversal') <> (NEW.reverses_entry_id IS NOT NULL) THEN
    RAISE EXCEPTION 'gl: reversals are posted by gl_reverse_entry and name the entry they reverse';
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL THEN
    SELECT * INTO v_target FROM public.gl_entries WHERE id = NEW.reverses_entry_id;
    IF NOT FOUND OR v_target.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'gl: a reversal must be in the same company as the entry it reverses';
    END IF;
    IF v_target.reverses_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'gl: entry % is itself a reversal', v_target.entry_no;
    END IF;
  END IF;

  NEW.period_id := v_period.id;
  NEW.posted_at := now();
  NEW.posted_txid := txid_current();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gl_entries_before_insert ON gl_entries;
CREATE TRIGGER gl_entries_before_insert BEFORE INSERT ON gl_entries
  FOR EACH ROW EXECUTE FUNCTION public.gl_entries_before_insert();

CREATE OR REPLACE FUNCTION public.gl_lines_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_entry public.gl_entries%ROWTYPE;
  v_account public.gl_accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM public.gl_entries WHERE id = NEW.entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: line for unknown entry %', NEW.entry_id;
  END IF;
  IF v_entry.posted_txid <> txid_current() THEN
    RAISE EXCEPTION 'gl: entry % is already posted; lines can only be added while it is being posted', v_entry.entry_no;
  END IF;

  SELECT * INTO v_account FROM public.gl_accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: unknown account %', NEW.account_id;
  END IF;
  -- A reversal may hit an account deactivated since the original posted.
  IF NOT v_account.active AND v_entry.reverses_entry_id IS NULL THEN
    RAISE EXCEPTION 'gl: account % (%) is inactive', v_account.number, v_account.name;
  END IF;
  IF v_account.company_id IS NOT NULL AND v_account.company_id <> v_entry.company_id THEN
    RAISE EXCEPTION 'gl: account % (%) belongs to another company', v_account.number, v_account.name;
  END IF;
  IF v_account.is_control AND v_entry.source_type = 'manual' THEN
    RAISE EXCEPTION 'gl: account % (%) is posted only by its own documents, not by a typed entry', v_account.number, v_account.name;
  END IF;

  NEW.company_id := v_entry.company_id;
  NEW.entry_date := v_entry.entry_date;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gl_lines_before_insert ON gl_lines;
CREATE TRIGGER gl_lines_before_insert BEFORE INSERT ON gl_lines
  FOR EACH ROW EXECUTE FUNCTION public.gl_lines_before_insert();

-- Runs when the posting transaction commits, after every line is in.
CREATE OR REPLACE FUNCTION public.gl_entry_balanced_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_lines INTEGER;
  v_debit NUMERIC;
  v_credit NUMERIC;
BEGIN
  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
  INTO v_lines, v_debit, v_credit
  FROM public.gl_lines WHERE entry_id = NEW.id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'gl: entry % has % line(s); an entry needs at least two', NEW.entry_no, v_lines;
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'gl: entry % does not balance: debits % vs credits %', NEW.entry_no, v_debit, v_credit;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS gl_entries_balanced ON gl_entries;
CREATE CONSTRAINT TRIGGER gl_entries_balanced AFTER INSERT ON gl_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.gl_entry_balanced_check();

CREATE OR REPLACE FUNCTION public.gl_no_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'gl: % rows can''t be changed or deleted; post a reversal instead', TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS gl_entries_no_change ON gl_entries;
CREATE TRIGGER gl_entries_no_change BEFORE UPDATE OR DELETE ON gl_entries
  FOR EACH ROW EXECUTE FUNCTION public.gl_no_change();
DROP TRIGGER IF EXISTS gl_lines_no_change ON gl_lines;
CREATE TRIGGER gl_lines_no_change BEFORE UPDATE OR DELETE ON gl_lines
  FOR EACH ROW EXECUTE FUNCTION public.gl_no_change();
DROP TRIGGER IF EXISTS gl_period_events_no_change ON gl_period_events;
CREATE TRIGGER gl_period_events_no_change BEFORE UPDATE OR DELETE ON gl_period_events
  FOR EACH ROW EXECUTE FUNCTION public.gl_no_change();

CREATE OR REPLACE FUNCTION public.gl_truncate_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.gl_companies WHERE books_live_from IS NOT NULL) THEN
    RAISE EXCEPTION 'gl: % can''t be emptied once any company''s books are live', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS gl_entries_truncate_guard ON gl_entries;
CREATE TRIGGER gl_entries_truncate_guard BEFORE TRUNCATE ON gl_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();
DROP TRIGGER IF EXISTS gl_lines_truncate_guard ON gl_lines;
CREATE TRIGGER gl_lines_truncate_guard BEFORE TRUNCATE ON gl_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();
DROP TRIGGER IF EXISTS gl_period_events_truncate_guard ON gl_period_events;
CREATE TRIGGER gl_period_events_truncate_guard BEFORE TRUNCATE ON gl_period_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();
DROP TRIGGER IF EXISTS gl_periods_truncate_guard ON gl_periods;
CREATE TRIGGER gl_periods_truncate_guard BEFORE TRUNCATE ON gl_periods
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();

-- ── Functions the server calls ─────────────────────────────────────────────

-- Posts one entry with its lines in one transaction. p:
--   { company: 'BMG', entry_date: 'YYYY-MM-DD', source_type, source_id?,
--     posting_rule, idempotency_key, memo?, posted_by?, posted_by_name?,
--     lines: [{ account_id, debit? | credit?, memo?, division?, location?,
--               customer_id?, vendor_ref?, job_ref?, item_number?, source_line_ref? }] }
-- Amounts are dollars with at most two decimals. A key that already posted
-- returns that entry with already_posted = true and writes nothing.
CREATE OR REPLACE FUNCTION public.gl_post_entry(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company UUID;
  v_date DATE;
  v_key TEXT := nullif(btrim(p->>'idempotency_key'), '');
  v_entry public.gl_entries%ROWTYPE;
  v_line JSONB;
  v_no INTEGER := 0;
  v_debit NUMERIC;
  v_credit NUMERIC;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'gl: idempotency_key is required';
  END IF;
  IF coalesce(p->>'entry_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'gl: entry_date must be YYYY-MM-DD';
  END IF;
  v_date := (p->>'entry_date')::date;
  IF jsonb_typeof(p->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: lines must be a list';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = p->>'company';
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: unknown company %', p->>'company';
  END IF;

  SELECT * INTO v_entry FROM public.gl_entries WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_entry.id, 'entry_no', v_entry.entry_no, 'already_posted', true);
  END IF;

  -- A month opens the first time anything posts to it.
  INSERT INTO public.gl_periods (company_id, period_start)
  VALUES (v_company, public.gl_month_start(v_date))
  ON CONFLICT (company_id, period_start) DO NOTHING;

  INSERT INTO public.gl_entries (
    company_id, entry_date, source_type, source_id, posting_rule, idempotency_key,
    memo, posted_by, posted_by_name
  ) VALUES (
    v_company, v_date, p->>'source_type', nullif(p->>'source_id', ''), p->>'posting_rule', v_key,
    nullif(p->>'memo', ''), nullif(p->>'posted_by', '')::uuid, nullif(p->>'posted_by_name', '')
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO v_entry;
  IF v_entry.id IS NULL THEN
    -- Another post with the same key committed while this one waited.
    SELECT * INTO v_entry FROM public.gl_entries WHERE idempotency_key = v_key;
    RETURN jsonb_build_object('id', v_entry.id, 'entry_no', v_entry.entry_no, 'already_posted', true);
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
    v_no := v_no + 1;
    v_debit := coalesce(nullif(v_line->>'debit', '')::numeric, 0);
    v_credit := coalesce(nullif(v_line->>'credit', '')::numeric, 0);
    IF v_debit <> round(v_debit, 2) OR v_credit <> round(v_credit, 2) THEN
      RAISE EXCEPTION 'gl: line % has more than two decimal places', v_no;
    END IF;
    INSERT INTO public.gl_lines (
      entry_id, line_no, company_id, entry_date, account_id, debit, credit, memo,
      division, location, customer_id, vendor_ref, job_ref, item_number, source_line_ref
    ) VALUES (
      v_entry.id, v_no, v_entry.company_id, v_entry.entry_date, nullif(v_line->>'account_id', '')::uuid,
      v_debit, v_credit, nullif(v_line->>'memo', ''),
      nullif(v_line->>'division', ''), nullif(v_line->>'location', ''),
      nullif(v_line->>'customer_id', '')::uuid, nullif(v_line->>'vendor_ref', ''),
      nullif(v_line->>'job_ref', ''), nullif(v_line->>'item_number', ''),
      nullif(v_line->>'source_line_ref', '')
    );
  END LOOP;

  -- The deferred trigger checks this again at commit; checking here as well
  -- returns the reason as this call's own error.
  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
  INTO v_no, v_debit, v_credit
  FROM public.gl_lines WHERE entry_id = v_entry.id;
  IF v_no < 2 THEN
    RAISE EXCEPTION 'gl: an entry needs at least two lines';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'gl: entry does not balance: debits % vs credits %', v_debit, v_credit;
  END IF;

  RETURN jsonb_build_object('id', v_entry.id, 'entry_no', v_entry.entry_no, 'already_posted', false);
END;
$$;

-- Posts the mirror image of an entry, dated p_date (default: the original's
-- date), linked through reverses_entry_id. An entry is reversed at most once,
-- and a reversal is never itself reversed: re-post the document instead.
CREATE OR REPLACE FUNCTION public.gl_reverse_entry(
  p_entry_id UUID, p_date DATE, p_memo TEXT, p_actor_id UUID, p_actor_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_orig public.gl_entries%ROWTYPE;
  v_rev public.gl_entries%ROWTYPE;
  v_date DATE;
BEGIN
  SELECT * INTO v_orig FROM public.gl_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: no entry %', p_entry_id;
  END IF;
  IF v_orig.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'gl: entry % is itself a reversal', v_orig.entry_no;
  END IF;
  IF EXISTS (SELECT 1 FROM public.gl_entries WHERE reverses_entry_id = v_orig.id) THEN
    RAISE EXCEPTION 'gl: entry % is already reversed', v_orig.entry_no;
  END IF;

  v_date := coalesce(p_date, v_orig.entry_date);
  INSERT INTO public.gl_periods (company_id, period_start)
  VALUES (v_orig.company_id, public.gl_month_start(v_date))
  ON CONFLICT (company_id, period_start) DO NOTHING;

  INSERT INTO public.gl_entries (
    company_id, entry_date, source_type, source_id, posting_rule, idempotency_key,
    memo, posted_by, posted_by_name, reverses_entry_id
  ) VALUES (
    v_orig.company_id, v_date, 'reversal', v_orig.id::text, 'reversal', 'reversal:' || v_orig.id::text,
    coalesce(nullif(btrim(p_memo), ''), 'Reverses entry ' || v_orig.entry_no), p_actor_id, nullif(p_actor_name, ''), v_orig.id
  )
  RETURNING * INTO v_rev;

  INSERT INTO public.gl_lines (
    entry_id, line_no, company_id, entry_date, account_id, debit, credit, memo,
    division, location, customer_id, vendor_ref, job_ref, item_number, source_line_ref
  )
  SELECT v_rev.id, l.line_no, v_rev.company_id, v_rev.entry_date, l.account_id, l.credit, l.debit, l.memo,
         l.division, l.location, l.customer_id, l.vendor_ref, l.job_ref, l.item_number, l.source_line_ref
  FROM public.gl_lines l
  WHERE l.entry_id = v_orig.id
  ORDER BY l.line_no;

  RETURN jsonb_build_object('id', v_rev.id, 'entry_no', v_rev.entry_no);
END;
$$;

-- Closes or reopens one month for one company. Reopening needs a reason;
-- either way gl_period_events records who, when and why.
CREATE OR REPLACE FUNCTION public.gl_set_period_status(
  p_company TEXT, p_month DATE, p_status TEXT, p_actor_id UUID, p_actor_name TEXT, p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company UUID;
  v_period public.gl_periods%ROWTYPE;
BEGIN
  IF p_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'gl: status must be open or closed';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = p_company;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: unknown company %', p_company;
  END IF;

  PERFORM set_config('gl.actor_id', coalesce(p_actor_id::text, ''), true);
  PERFORM set_config('gl.actor_name', coalesce(p_actor_name, ''), true);
  PERFORM set_config('gl.reason', coalesce(p_reason, ''), true);

  INSERT INTO public.gl_periods (company_id, period_start)
  VALUES (v_company, public.gl_month_start(p_month))
  ON CONFLICT (company_id, period_start) DO NOTHING;

  UPDATE public.gl_periods SET status = p_status
  WHERE company_id = v_company AND period_start = public.gl_month_start(p_month)
  RETURNING * INTO v_period;

  RETURN jsonb_build_object('id', v_period.id, 'period_start', v_period.period_start, 'status', v_period.status);
END;
$$;

-- Empties the journal and its months (with their close history) so a
-- rehearsal can run again. Refused (by the truncate guard) once any
-- company's books are live. SECURITY DEFINER because restarting the entry
-- numbers needs the sequence's owner; only the service role may call it.
CREATE OR REPLACE FUNCTION public.gl_reset_journal()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  TRUNCATE public.gl_lines, public.gl_entries, public.gl_period_events, public.gl_periods RESTART IDENTITY;
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gl_companies', 'gl_accounts', 'gl_periods', 'gl_period_events', 'gl_entries', 'gl_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_post_entry(jsonb)',
    'public.gl_reverse_entry(uuid, date, text, uuid, text)',
    'public.gl_set_period_status(text, date, text, uuid, text, text)',
    'public.gl_reset_journal()'
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

-- House convention (migrations 308, 313, 314): every new table states its
-- writer and reader, and every column whose NULL or format is load-bearing
-- says so.
COMMENT ON TABLE gl_companies IS 'Migration 359: the companies FleetSuite keeps books for (BMG and 1084 Cool Springs). Service-role write and read.';
COMMENT ON COLUMN gl_companies.netsuite_subsidiary_id IS 'The NetSuite subsidiary whose books this company mirrors during 2027 (BMG = 2). NULL = not linked yet.';
COMMENT ON COLUMN gl_companies.books_live_from IS 'NULL while the journal is being built and may be emptied for rehearsals. Once set (planned 2027-01-01) it never changes, entries dated earlier are refused except opening balances, and the journal can''t be emptied.';
COMMENT ON TABLE gl_accounts IS 'Migration 359: the chart of accounts, shared by both companies unless company_id restricts an account to one. Service-role write and read.';
COMMENT ON COLUMN gl_accounts.number IS 'The GL account number shown on reports (NetSuite acctnumber) — never a bank or card account number.';
COMMENT ON COLUMN gl_accounts.company_id IS 'NULL = usable by every company; set = only that company may post to it.';
COMMENT ON COLUMN gl_accounts.netsuite_account_id IS 'The NetSuite account this one mirrors during 2027, for the side-by-side checks. NULL for an account NetSuite doesn''t have.';
COMMENT ON COLUMN gl_accounts.is_control IS 'AR, AP, inventory and the like: only the documents behind the account post to it, never a typed (source_type = ''manual'') entry.';
COMMENT ON TABLE gl_periods IS 'Migration 359: one row per company per month. A month opens the first time anything posts to it; a closed month refuses new entries. Change status only through gl_set_period_status. Service-role write and read.';
COMMENT ON TABLE gl_period_events IS 'Migration 359: every close and reopen, with who, when and why. Written by a trigger on gl_periods; rows are never changed. Service-role read.';
COMMENT ON TABLE gl_entries IS 'Migration 359: FleetSuite''s posted journal entries. Inserted only through gl_post_entry / gl_reverse_entry; never updated or deleted. Service-role read.';
COMMENT ON COLUMN gl_entries.source_type IS 'What caused the entry: the document type (''invoice'', ''vendor_bill'', …), ''manual'' for a typed entry, ''reversal'', or ''opening_balance''.';
COMMENT ON COLUMN gl_entries.posting_rule IS 'Which rule produced the entry, with its version (''invoice@1''), so a rule change is traceable; ''manual'' for a typed entry.';
COMMENT ON COLUMN gl_entries.idempotency_key IS 'Unique per posting: the same document, rule and generation can never post twice.';
COMMENT ON COLUMN gl_entries.posted_by IS 'profiles.id of the person who posted, kept without a foreign key so the journal never blocks or follows a profile change. NULL = posted by the system.';
COMMENT ON COLUMN gl_entries.posted_txid IS 'The transaction that posted the entry; lines are accepted only from that same transaction.';
COMMENT ON TABLE gl_lines IS 'Migration 359: the debit and credit lines of each entry. company_id and entry_date are copied from the entry by trigger. Never updated or deleted. Service-role read.';
COMMENT ON COLUMN gl_lines.location IS 'Location key as src/lib/invoice-location.ts names it (''ofallon'', ''socialcircle'', …). NULL = not location-specific.';
COMMENT ON COLUMN gl_lines.customer_id IS 'customers.id, kept without a foreign key so customer merges and deletes never collide with the journal.';
COMMENT ON COLUMN gl_lines.job_ref IS 'The job a line belongs to, as ''<kind>:<id>'' (a sales order or a vehicle). NULL = no job.';
