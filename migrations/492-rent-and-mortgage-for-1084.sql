-- Migration 492: FleetSuite's own books, part 61 — 1084 Cool Springs' rent
-- and mortgage, month by month.
--
-- 1084 Cool Springs LLC owns the building BMG rents, and its only business
-- is BMG's rent coming in and the mortgage going out (owner, 2026-10-10,
-- thread "Replacing NetSuite with FleetSuite"). This is the NetSuite Exit
-- Checklist's "1084's monthly entries", first slice
-- (src/lib/books/rent-and-mortgage.ts, /api/admin/books/rent-and-mortgage,
-- page /admin/books/rent-and-mortgage, docs/books.md "1084's rent and
-- mortgage"):
--
--   * rent_mortgage_setups, one row per company that's a landlord (1084):
--     the accounts its months are read from and booked to, each by NetSuite's
--     id (its bank, its rent income, the tenant's rent, which is BMG's, its
--     mortgage, the mortgage's interest, and escrow when the lender holds
--     some), and the lender's name;
--   * rent_mortgage_months, one row per company and month: the rent received
--     from the tenant and the day, and the lender's statement for the payment
--     made in the month (the day it was paid, what went to principal,
--     interest and escrow, and the principal left after it), each in the
--     month the books show it in, with the two typed journal entries
--     (migration 469) that book them once they're made.
--
-- A month's entries are typed journal entries in the general journal, so
-- they're asked for, approved and sent on to NetSuite as any other is, and
-- they ride the journal_entries switch: while that's off, only super admins
-- type them, and none is asked for approval or sent. What an entry books
-- stays as it is once that entry is asked for approval. Deleting an entry's
-- draft on the Journal entries page lets go of it, and the month's next one
-- is made new.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- ── How a landlord's months are read and booked ───────────────────────────

CREATE TABLE IF NOT EXISTS rent_mortgage_setups (
  company TEXT PRIMARY KEY REFERENCES gl_companies(code) ON DELETE RESTRICT,
  -- The accounts, each by NetSuite's id, or none picked yet.
  bank_account TEXT CHECK (bank_account ~ '^[0-9]+$'),
  rent_income_account TEXT CHECK (rent_income_account ~ '^[0-9]+$'),
  -- The tenant's (BMG's) account its rent is booked to.
  tenant_rent_account TEXT CHECK (tenant_rent_account ~ '^[0-9]+$'),
  mortgage_account TEXT CHECK (mortgage_account ~ '^[0-9]+$'),
  interest_account TEXT CHECK (interest_account ~ '^[0-9]+$'),
  -- None when the lender holds no escrow.
  escrow_account TEXT CHECK (escrow_account ~ '^[0-9]+$'),
  lender TEXT CHECK (lender = btrim(lender) AND length(lender) BETWEEN 1 AND 100),
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Each month ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_mortgage_months (
  company TEXT NOT NULL REFERENCES gl_companies(code) ON DELETE RESTRICT,
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  -- The rent received from the tenant in the month, and the day.
  rent_date DATE,
  rent_cents BIGINT CHECK (rent_cents > 0 AND rent_cents <= 10000000000),
  -- The lender's statement for the payment made in the month.
  paid_on DATE,
  principal_cents BIGINT CHECK (principal_cents >= 0 AND principal_cents <= 10000000000),
  interest_cents BIGINT CHECK (interest_cents >= 0 AND interest_cents <= 10000000000),
  escrow_cents BIGINT CHECK (escrow_cents >= 0 AND escrow_cents <= 10000000000),
  -- The principal left after the payment, as the statement says.
  balance_after_cents BIGINT CHECK (balance_after_cents >= 0 AND balance_after_cents <= 10000000000),
  -- The typed journal entries that book them, once made.
  rent_entry_id UUID REFERENCES typed_journal_entries(id) ON DELETE SET NULL,
  mortgage_entry_id UUID REFERENCES typed_journal_entries(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company, month),
  CONSTRAINT rent_mortgage_rent_whole CHECK ((rent_date IS NULL) = (rent_cents IS NULL)),
  CONSTRAINT rent_mortgage_rent_in_month CHECK (rent_date IS NULL OR public.gl_month_start(rent_date) = month),
  CONSTRAINT rent_mortgage_statement_whole CHECK (
    (paid_on IS NULL AND principal_cents IS NULL AND interest_cents IS NULL AND escrow_cents IS NULL AND balance_after_cents IS NULL)
    OR (paid_on IS NOT NULL AND principal_cents IS NOT NULL AND interest_cents IS NOT NULL AND escrow_cents IS NOT NULL
        AND balance_after_cents IS NOT NULL AND principal_cents + interest_cents + escrow_cents > 0)),
  CONSTRAINT rent_mortgage_paid_in_month CHECK (paid_on IS NULL OR public.gl_month_start(paid_on) = month),
  CONSTRAINT rent_mortgage_entries_apart CHECK (rent_entry_id IS NULL OR rent_entry_id IS DISTINCT FROM mortgage_entry_id)
);
-- An entry books one month, once.
CREATE UNIQUE INDEX IF NOT EXISTS rent_mortgage_months_rent_entry ON rent_mortgage_months (rent_entry_id) WHERE rent_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rent_mortgage_months_mortgage_entry ON rent_mortgage_months (mortgage_entry_id) WHERE mortgage_entry_id IS NOT NULL;

-- Saves a month's figures as typed. p:
--   { company, month: 'YYYY-MM-01', seen: its updated_at as the page saw it, or null for a month not saved yet,
--     rent: { date, cents } | null,
--     statement: { paid_on, principal_cents, interest_cents, escrow_cents, balance_after_cents } | null, by }
-- What an entry booked stays as it is once that entry is asked for approval: changing the rent then answers
-- 'rent_asked', the statement 'statement_asked', each with where the entry is. Answers { state: 'saved', updated_at },
-- or 'changed' when the month was saved since the page saw it.
CREATE OR REPLACE FUNCTION public.rent_mortgage_month_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company TEXT := btrim(p->>'company');
  v_month DATE := (p->>'month')::date;
  v_rent_date DATE := (p->'rent'->>'date')::date;
  v_rent_cents BIGINT := (p->'rent'->>'cents')::bigint;
  v_paid_on DATE := (p->'statement'->>'paid_on')::date;
  v_principal BIGINT := (p->'statement'->>'principal_cents')::bigint;
  v_interest BIGINT := (p->'statement'->>'interest_cents')::bigint;
  v_escrow BIGINT := (p->'statement'->>'escrow_cents')::bigint;
  v_balance BIGINT := (p->'statement'->>'balance_after_cents')::bigint;
  v_by UUID := nullif(p->>'by', '')::uuid;
  v_row public.rent_mortgage_months;
  v_status TEXT;
BEGIN
  SELECT * INTO v_row FROM public.rent_mortgage_months WHERE company = v_company AND month = v_month FOR UPDATE;
  IF NOT FOUND THEN
    IF p->>'seen' IS NOT NULL THEN
      RETURN jsonb_build_object('state', 'changed');
    END IF;
    INSERT INTO public.rent_mortgage_months (company, month, rent_date, rent_cents, paid_on, principal_cents, interest_cents,
                                             escrow_cents, balance_after_cents, updated_by)
    VALUES (v_company, v_month, v_rent_date, v_rent_cents, v_paid_on, v_principal, v_interest, v_escrow, v_balance, v_by)
    ON CONFLICT (company, month) DO NOTHING
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      -- Saved by someone else at the same moment.
      RETURN jsonb_build_object('state', 'changed');
    END IF;
    RETURN jsonb_build_object('state', 'saved', 'updated_at', v_row.updated_at);
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'seen')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;

  IF ROW(v_row.rent_date, v_row.rent_cents) IS NOT DISTINCT FROM ROW(v_rent_date, v_rent_cents)
     AND ROW(v_row.paid_on, v_row.principal_cents, v_row.interest_cents, v_row.escrow_cents, v_row.balance_after_cents)
         IS NOT DISTINCT FROM ROW(v_paid_on, v_principal, v_interest, v_escrow, v_balance) THEN
    RETURN jsonb_build_object('state', 'saved', 'updated_at', v_row.updated_at, 'unchanged', true);
  END IF;
  IF v_row.rent_entry_id IS NOT NULL AND ROW(v_row.rent_date, v_row.rent_cents) IS DISTINCT FROM ROW(v_rent_date, v_rent_cents) THEN
    SELECT status INTO v_status FROM public.typed_journal_entries WHERE id = v_row.rent_entry_id;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RETURN jsonb_build_object('state', 'rent_asked', 'status', v_status);
    END IF;
  END IF;
  IF v_row.mortgage_entry_id IS NOT NULL
     AND ROW(v_row.paid_on, v_row.principal_cents, v_row.interest_cents, v_row.escrow_cents, v_row.balance_after_cents)
         IS DISTINCT FROM ROW(v_paid_on, v_principal, v_interest, v_escrow, v_balance) THEN
    SELECT status INTO v_status FROM public.typed_journal_entries WHERE id = v_row.mortgage_entry_id;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RETURN jsonb_build_object('state', 'statement_asked', 'status', v_status);
    END IF;
  END IF;

  UPDATE public.rent_mortgage_months
  SET rent_date = v_rent_date, rent_cents = v_rent_cents, paid_on = v_paid_on, principal_cents = v_principal,
      interest_cents = v_interest, escrow_cents = v_escrow, balance_after_cents = v_balance, updated_by = v_by, updated_at = now()
  WHERE company = v_company AND month = v_month
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'saved', 'updated_at', v_row.updated_at);
END;
$$;

-- Makes or changes one of a month's entries, as a draft typed journal entry in the general journal (migration 469),
-- worked out from the month's figures as saved. p:
--   { company, month, kind: 'rent' | 'mortgage', id: a new id, used when the month has no entry of the kind yet,
--     seen: the month's updated_at the entry was worked out from, tran_date, memo, lines, by }
-- Answers { state: 'saved', id, status, updated_at }; { state: 'kept', id, status } when the entry is asked for
-- approval, being made or made, and stays as it is; 'changed' when the month was saved again since; 'gone' when
-- there's no such month; 'taken' when the new id is another entry's already.
CREATE OR REPLACE FUNCTION public.rent_mortgage_entry_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_kind TEXT := p->>'kind';
  v_row public.rent_mortgage_months;
  v_id UUID;
  v_saved JSONB;
BEGIN
  IF v_kind IS DISTINCT FROM 'rent' AND v_kind IS DISTINCT FROM 'mortgage' THEN
    RAISE EXCEPTION 'rent and mortgage: there''s no % entry', coalesce(v_kind, 'unnamed');
  END IF;
  SELECT * INTO v_row FROM public.rent_mortgage_months WHERE company = btrim(p->>'company') AND month = (p->>'month')::date FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'seen')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;

  v_id := CASE v_kind WHEN 'rent' THEN v_row.rent_entry_id ELSE v_row.mortgage_entry_id END;
  IF v_id IS NULL THEN
    v_id := (p->>'id')::uuid;
    IF EXISTS (SELECT 1 FROM public.typed_journal_entries WHERE id = v_id) THEN
      RETURN jsonb_build_object('state', 'taken');
    END IF;
  END IF;

  v_saved := public.typed_journal_entry_save(jsonb_build_object(
    'id', v_id, 'journal', 'general', 'company', v_row.company, 'tran_date', p->>'tran_date', 'memo', p->>'memo',
    'lines', coalesce(p->'lines', '[]'::jsonb), 'by', p->>'by'));
  IF v_saved->>'status' = 'gone' THEN
    -- Its draft was deleted between the two: the next try makes it new.
    RETURN jsonb_build_object('state', 'changed');
  END IF;
  IF (v_saved->>'saved')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object('state', 'kept', 'id', v_id, 'status', v_saved->>'status');
  END IF;

  -- The month's entry of the kind from now on. The month's own updated_at stays as it is: it says when its figures
  -- were saved, which the next save of them is checked against.
  IF v_kind = 'rent' THEN
    UPDATE public.rent_mortgage_months SET rent_entry_id = v_id
    WHERE company = v_row.company AND month = v_row.month AND rent_entry_id IS NULL;
  ELSE
    UPDATE public.rent_mortgage_months SET mortgage_entry_id = v_id
    WHERE company = v_row.company AND month = v_row.month AND mortgage_entry_id IS NULL;
  END IF;
  RETURN jsonb_build_object('state', 'saved', 'id', v_id, 'status', v_saved->>'status', 'updated_at', v_saved->>'updated_at');
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.rent_mortgage_setups', 'public.rent_mortgage_months'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.rent_mortgage_month_save(jsonb)', 'public.rent_mortgage_entry_save(jsonb)'] LOOP
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

COMMENT ON TABLE rent_mortgage_setups IS 'Migration 492: how a landlord company''s (1084''s) months are read from and booked to its books (src/lib/books/rent-and-mortgage.ts, /api/admin/books/rent-and-mortgage): its bank, rent income, mortgage, interest and escrow accounts, the tenant''s (BMG''s) rent account, each by NetSuite''s id, and the lender''s name. Service-role write and read.';
COMMENT ON TABLE rent_mortgage_months IS 'Migration 492: a landlord company''s month: the rent received from the tenant and the day, the lender''s statement for the payment made in the month (paid on, principal, interest, escrow, principal left), and the typed journal entries (migration 469) that book them once made. What an entry booked stays as it is once it''s asked for approval. Moved only by its functions. Service-role write and read.';
COMMENT ON FUNCTION public.rent_mortgage_month_save(jsonb) IS 'Migration 492: saves a month''s rent received and lender''s statement as typed, as the page saw the month; what an entry booked stays as it is once that entry is asked for approval. Service role only.';
COMMENT ON FUNCTION public.rent_mortgage_entry_save(jsonb) IS 'Migration 492: makes or changes a month''s rent or mortgage entry as a draft typed journal entry in the general journal, from its figures as saved; an entry asked for approval or made stays as it is. Service role only.';
