-- Migration 502: FleetSuite's own books, part 74 — closing a company's year.
--
-- Owner decision 2026-10-31 (thread "Replacing NetSuite with FleetSuite",
-- the NetSuite Exit Checklist's "Year-end close": each company's year
-- closed into retained earnings). FleetSuite's reports already take a
-- year's net income into retained earnings at the next one's start, with
-- no closing entry, as NetSuite's do (src/lib/books/reports.ts). Closing a
-- year here signs that off and holds it: Books → Year end closes a
-- company's year once every month of it in FleetSuite's books is closed
-- (Books → Months, migration 359), and from then on none of those months
-- reopens until the year does (src/lib/books/year-end.ts, docs/books.md
-- "Year end"). This adds:
--   * gl_year_closes, a row for each company's year once it's first
--     closed: whether it's closed now, who closed it and when, and what
--     FleetSuite's books had then for the year's net income and for
--     retained earnings once it closed into them;
--   * gl_year_close_events, every close and reopen with who, when, why and
--     those amounts, never changed, and never emptied once books are live;
--   * gl_set_year_status(company, year, status, actor id, actor name,
--     reason, net income, retained earnings), which closes or reopens a
--     year. A year closes once the company's books are live, if it isn't
--     before the year they went live in, every month of it from January (or
--     the month they went live) through December is closed, and every year
--     before it since then is closed. Only the latest year closed reopens,
--     and only for a reason;
--   * gl_periods_year_lock, a trigger on gl_periods: a month in a closed
--     year doesn't reopen.
--
-- Nothing is posted and nothing goes to NetSuite. Writer and reader: the
-- service role only.

-- ── The years ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_year_closes (
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  year INT NOT NULL CHECK (year BETWEEN 2025 AND 2200),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,
  -- profiles.id, kept without a foreign key as the journal keeps who closed a month.
  closed_by UUID,
  closed_by_name TEXT,
  -- What FleetSuite's books had when it closed, whole cents: the year's net
  -- income, a profit positive, and retained earnings once it closed into
  -- them, credit positive, as the balance sheet shows equity.
  net_income_cents BIGINT,
  retained_earnings_cents BIGINT,
  PRIMARY KEY (company_id, year),
  CONSTRAINT gl_year_closes_whole CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
    AND (status = 'closed') = (net_income_cents IS NOT NULL)
    AND (status = 'closed') = (retained_earnings_cents IS NOT NULL)
    AND (status = 'closed' OR (closed_by IS NULL AND closed_by_name IS NULL))
  )
);

CREATE TABLE IF NOT EXISTS gl_year_close_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  year INT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('closed', 'reopened')),
  actor_id UUID,
  actor_name TEXT,
  reason TEXT CHECK (reason IS NULL OR (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500)),
  net_income_cents BIGINT,
  retained_earnings_cents BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gl_year_close_events_reason CHECK (action = 'closed' OR reason IS NOT NULL),
  CONSTRAINT gl_year_close_events_amounts CHECK (
    (action = 'closed') = (net_income_cents IS NOT NULL)
    AND (action = 'closed') = (retained_earnings_cents IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_gl_year_close_events_year ON gl_year_close_events (company_id, year, created_at);

-- A year's row stays once it's made, and its events never change.
DROP TRIGGER IF EXISTS gl_year_closes_no_delete ON gl_year_closes;
CREATE TRIGGER gl_year_closes_no_delete BEFORE DELETE ON gl_year_closes
  FOR EACH ROW EXECUTE FUNCTION public.gl_no_change();
DROP TRIGGER IF EXISTS gl_year_close_events_no_change ON gl_year_close_events;
CREATE TRIGGER gl_year_close_events_no_change BEFORE UPDATE OR DELETE ON gl_year_close_events
  FOR EACH ROW EXECUTE FUNCTION public.gl_no_change();
DROP TRIGGER IF EXISTS gl_year_closes_truncate_guard ON gl_year_closes;
CREATE TRIGGER gl_year_closes_truncate_guard BEFORE TRUNCATE ON gl_year_closes
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();
DROP TRIGGER IF EXISTS gl_year_close_events_truncate_guard ON gl_year_close_events;
CREATE TRIGGER gl_year_close_events_truncate_guard BEFORE TRUNCATE ON gl_year_close_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();

-- ── A closed year's months stay closed ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_periods_year_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'open' AND OLD.status = 'closed' AND EXISTS (
    SELECT 1 FROM public.gl_year_closes y
    WHERE y.company_id = OLD.company_id
      AND y.year = EXTRACT(YEAR FROM OLD.period_start)::int
      AND y.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'gl: % is closed, so % stays closed until the year is reopened',
      EXTRACT(YEAR FROM OLD.period_start)::int, to_char(OLD.period_start, 'FMMonth YYYY');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gl_periods_year_lock ON gl_periods;
CREATE TRIGGER gl_periods_year_lock BEFORE UPDATE OF status ON gl_periods
  FOR EACH ROW EXECUTE FUNCTION public.gl_periods_year_lock();

-- ── Closing and reopening a year ───────────────────────────────────────────

-- Closes (p_status 'closed') or reopens ('open') one company's year, and
-- logs it. Closing keeps the year's net income and retained earnings after
-- the close as FleetSuite's books have them, which the page works out
-- (src/lib/books/reports.ts's yearCloseAmounts); reopening needs a reason.
-- Returns { year, status, closed_at }.
CREATE OR REPLACE FUNCTION public.gl_set_year_status(
  p_company TEXT, p_year INT, p_status TEXT, p_actor_id UUID, p_actor_name TEXT, p_reason TEXT,
  p_net_income_cents BIGINT, p_retained_earnings_cents BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company public.gl_companies%ROWTYPE;
  v_reason TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  v_name TEXT := nullif(btrim(coalesce(p_actor_name, '')), '');
  v_live INT;
  v_first DATE;
  v_open DATE;
  v_other INT;
  v_row public.gl_year_closes%ROWTYPE;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'gl: status must be open or closed';
  END IF;
  -- One close or reopen of a company's years at a time. NO KEY UPDATE leaves
  -- postings, which only check the company is there, to go on meanwhile.
  SELECT * INTO v_company FROM public.gl_companies WHERE code = p_company FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: unknown company %', p_company;
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'gl: a reason is 500 characters at most';
  END IF;

  IF p_status = 'closed' THEN
    IF v_company.books_live_from IS NULL THEN
      RAISE EXCEPTION 'gl: %''s books aren''t live yet, so no year closes', v_company.name;
    END IF;
    v_live := EXTRACT(YEAR FROM v_company.books_live_from)::int;
    IF p_year IS NULL OR p_year < v_live THEN
      RAISE EXCEPTION 'gl: % is before %''s books went live, so it closes in NetSuite', coalesce(p_year::text, 'That year'), v_company.name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.gl_year_closes WHERE company_id = v_company.id AND year = p_year AND status = 'closed') THEN
      RAISE EXCEPTION 'gl: % is already closed', p_year;
    END IF;
    SELECT min(y) INTO v_other
    FROM generate_series(v_live, p_year - 1) AS y
    WHERE NOT EXISTS (
      SELECT 1 FROM public.gl_year_closes c WHERE c.company_id = v_company.id AND c.year = y AND c.status = 'closed'
    );
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'gl: % has to close first: years close in order', v_other;
    END IF;

    -- Holds the year's months as they are until this commits, so none of
    -- them reopens in between.
    v_first := greatest(make_date(p_year, 1, 1), public.gl_month_start(v_company.books_live_from));
    PERFORM 1 FROM public.gl_periods
    WHERE company_id = v_company.id AND period_start BETWEEN v_first AND make_date(p_year, 12, 1)
    FOR UPDATE;
    SELECT min(m)::date INTO v_open
    FROM generate_series(v_first::timestamp, make_date(p_year, 12, 1)::timestamp, INTERVAL '1 month') AS m
    WHERE NOT EXISTS (
      SELECT 1 FROM public.gl_periods p
      WHERE p.company_id = v_company.id AND p.period_start = m::date AND p.status = 'closed'
    );
    IF v_open IS NOT NULL THEN
      RAISE EXCEPTION 'gl: % has to close before % does', to_char(v_open, 'FMMonth YYYY'), p_year;
    END IF;
    IF p_net_income_cents IS NULL OR p_retained_earnings_cents IS NULL THEN
      RAISE EXCEPTION 'gl: closing a year keeps its net income and retained earnings';
    END IF;

    INSERT INTO public.gl_year_closes AS c
      (company_id, year, status, closed_at, closed_by, closed_by_name, net_income_cents, retained_earnings_cents)
    VALUES (v_company.id, p_year, 'closed', now(), p_actor_id, v_name, p_net_income_cents, p_retained_earnings_cents)
    ON CONFLICT (company_id, year) DO UPDATE SET
      status = 'closed',
      closed_at = EXCLUDED.closed_at,
      closed_by = EXCLUDED.closed_by,
      closed_by_name = EXCLUDED.closed_by_name,
      net_income_cents = EXCLUDED.net_income_cents,
      retained_earnings_cents = EXCLUDED.retained_earnings_cents
    RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row FROM public.gl_year_closes WHERE company_id = v_company.id AND year = p_year;
    IF NOT FOUND OR v_row.status <> 'closed' THEN
      RAISE EXCEPTION 'gl: % isn''t closed', coalesce(p_year::text, 'That year');
    END IF;
    SELECT max(year) INTO v_other
    FROM public.gl_year_closes WHERE company_id = v_company.id AND year > p_year AND status = 'closed';
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'gl: % has to reopen first: years reopen from the latest', v_other;
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'gl: reopening % needs a reason', p_year;
    END IF;
    UPDATE public.gl_year_closes SET
      status = 'open', closed_at = NULL, closed_by = NULL, closed_by_name = NULL,
      net_income_cents = NULL, retained_earnings_cents = NULL
    WHERE company_id = v_company.id AND year = p_year
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO public.gl_year_close_events
    (company_id, year, action, actor_id, actor_name, reason, net_income_cents, retained_earnings_cents)
  VALUES (
    v_company.id, p_year,
    CASE WHEN p_status = 'closed' THEN 'closed' ELSE 'reopened' END,
    p_actor_id, v_name, v_reason,
    CASE WHEN p_status = 'closed' THEN p_net_income_cents END,
    CASE WHEN p_status = 'closed' THEN p_retained_earnings_cents END
  );

  RETURN jsonb_build_object('year', v_row.year, 'status', v_row.status, 'closed_at', v_row.closed_at);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gl_year_closes', 'gl_year_close_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.gl_set_year_status(text, integer, text, uuid, text, text, bigint, bigint)'] LOOP
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

COMMENT ON TABLE gl_year_closes IS 'Migration 502: one row per company per year once it''s first closed (Books → Year end): closed or open now, who closed it and when, and FleetSuite''s net income for the year (a profit positive) and retained earnings after the close (credit positive) when it closed. A closed year''s months don''t reopen. Change only through gl_set_year_status; rows are never deleted. Service-role write and read.';
COMMENT ON TABLE gl_year_close_events IS 'Migration 502: every close and reopen of a year, with who, when, why and the amounts on closing. Written by gl_set_year_status; rows are never changed. Service-role read.';
COMMENT ON FUNCTION public.gl_set_year_status(text, integer, text, uuid, text, text, bigint, bigint) IS 'Migration 502: closes or reopens one company''s year in FleetSuite''s books. Closes once the books are live, from the year they went live, when every month of it is closed and every year before it since then is; reopens only the latest year closed, for a reason. Logs both in gl_year_close_events. Service role only.';
