-- Migration 489: FleetSuite's own books, part 58 — checks printed on BMG's
-- stock: a payment run's checks numbered in NetSuite and printed from
-- FleetSuite on the pre-printed check stock, laid out for each bank account.
--
-- Owner facts (thread "Replacing NetSuite with FleetSuite"): vendor checks
-- print on pre-printed check stock (2026-10-10), and the NetSuite Exit
-- Checklist's "Pay vendors" has checks printed on BMG's stock. Part 57 makes
-- a run's checks in NetSuite To Be Printed (migration 488). This is its
-- second slice (src/lib/check-printing.ts, src/lib/check-pdf.ts,
-- /api/pay-vendors/checks, a run's Checks on page /admin/pay-vendors,
-- docs/books.md "Checks printed on BMG's stock"):
--
--   * vendor_check_layouts, one row per bank account: where the check is on
--     a sheet of its stock (top, middle or bottom; the other two parts are
--     stubs), and how far the print moves right and down, in sixteenths of
--     an inch. A bank account with none prints at the top, not moved;
--   * vendor_checks, one row per check number FleetSuite gives on a bank
--     account, never the same one twice, spoiled ones too. A run's check
--     made in NetSuite takes the next number on the stock in the printer
--     (numbering); FleetSuite sets it in NetSuite, which takes the check off
--     NetSuite's Print Checks (numbered); and it's printed (printed), or it
--     didn't print right and keeps its number with why (spoiled), and the
--     payment takes another. A number NetSuite didn't take is let go. A
--     check printed from NetSuite before FleetSuite numbered it is kept with
--     NetSuite's number (printed_in_netsuite). A payment has one check at a
--     time that isn't spoiled. Its number goes on the payment, and on Books'
--     own copy of the bill payment, as NetSuite's number for it;
--   * the numbers used on a bank account, by FleetSuite's checks and by the
--     checks, bill payments and refunds in NetSuite's copy (migration 361),
--     so a number is never given twice, and the highest, for the next.
--
-- It rides on the vendor_payments switch (migration 488): no run is
-- approved while that's off, so no check is numbered or printed.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── Where the print lands ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_check_layouts (
  -- The bank account, by NetSuite's id: each account's stock can sit differently in the printer.
  bank_account_netsuite_id TEXT PRIMARY KEY CHECK (bank_account_netsuite_id ~ '^[0-9]+$'),
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  -- The part of the sheet the check is in; the other two are stubs.
  check_position TEXT NOT NULL DEFAULT 'top' CHECK (check_position IN ('top', 'middle', 'bottom')),
  -- Sixteenths of an inch: right (less than 0 is left) and down (less than 0 is up), an inch at most.
  right_sixteenths INTEGER NOT NULL DEFAULT 0 CHECK (right_sixteenths BETWEEN -16 AND 16),
  down_sixteenths INTEGER NOT NULL DEFAULT 0 CHECK (down_sixteenths BETWEEN -16 AND 16),
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── The checks ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  -- The bank account it's drawn on, and its number on that account's stock.
  bank_account_netsuite_id TEXT NOT NULL CHECK (bank_account_netsuite_id ~ '^[0-9]+$'),
  check_number BIGINT NOT NULL CHECK (check_number BETWEEN 1 AND 99999999),
  run_id UUID NOT NULL REFERENCES vendor_payment_runs(id) ON DELETE RESTRICT,
  payment_id UUID NOT NULL REFERENCES vendor_payment_run_payments(id) ON DELETE RESTRICT,
  -- NetSuite's id for the bill payment the check pays.
  netsuite_payment_id TEXT NOT NULL CHECK (netsuite_payment_id ~ '^[0-9]+$'),
  status TEXT NOT NULL CHECK (status IN ('numbering', 'numbered', 'printed', 'spoiled', 'printed_in_netsuite')),
  -- What FleetSuite prints on it, so printing it again prints the same: { date, payee, address, cents, memo,
  -- vendor_name, account_name, bills: [{ number, date, cents }] } (src/lib/check-printing.ts). None for one NetSuite printed.
  printed_as JSONB CHECK (printed_as IS NULL OR jsonb_typeof(printed_as) = 'object'),
  -- Who gave it its number, and when; while it's numbering, how long NetSuite's had it.
  numbered_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  numbered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Why FleetSuite can't tell whether NetSuite took the number.
  error TEXT CHECK (length(error) <= 2000),
  printed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  printed_at TIMESTAMPTZ,
  -- It didn't print right, and why: its number is kept, so it's never given again.
  spoiled_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  spoiled_at TIMESTAMPTZ,
  spoiled_reason TEXT CHECK (length(spoiled_reason) <= 300),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bank_account_netsuite_id, check_number),
  CHECK (status = 'printed_in_netsuite' OR printed_as IS NOT NULL),
  CHECK (status <> 'printed' OR printed_at IS NOT NULL),
  CHECK ((status = 'spoiled') = (spoiled_at IS NOT NULL)),
  CHECK (status <> 'spoiled' OR btrim(coalesce(spoiled_reason, '')) <> '')
);
-- A payment has one check at a time that isn't spoiled.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_checks_one_live_idx ON vendor_checks (payment_id) WHERE status <> 'spoiled';
CREATE INDEX IF NOT EXISTS vendor_checks_run_idx ON vendor_checks (run_id, check_number);

-- The check numbers from p_from to p_to used already on this bank account: by a check FleetSuite numbered, spoiled
-- ones too, or by a check, bill payment or refund in NetSuite's copy (migration 361) with that number.
CREATE OR REPLACE FUNCTION public.vendor_check_numbers_used(p_account TEXT, p_from BIGINT, p_to BIGINT)
RETURNS BIGINT[]
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(DISTINCT u.n ORDER BY u.n), ARRAY[]::BIGINT[])
  FROM (
    SELECT c.check_number AS n
    FROM public.vendor_checks c
    WHERE c.bank_account_netsuite_id = p_account AND c.check_number BETWEEN p_from AND p_to
    UNION ALL
    SELECT t.n
    FROM (
      SELECT x.netsuite_id, CASE WHEN x.tranid ~ '^[0-9]{1,8}$' THEN x.tranid::bigint END AS n
      FROM public.gl_netsuite_transactions x
      WHERE x.tran_type IN ('Check', 'VendPymt', 'CustRfnd')
    ) AS t
    WHERE t.n BETWEEN p_from AND p_to
      AND EXISTS (SELECT 1 FROM public.gl_netsuite_lines l WHERE l.transaction_id = t.netsuite_id AND l.netsuite_account_id = p_account)
  ) AS u;
$$;

-- The highest check number used on this bank account, the same way, for the next one; null when none is.
CREATE OR REPLACE FUNCTION public.vendor_check_last_number(p_account TEXT)
RETURNS BIGINT
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT max(u.n)
  FROM (
    SELECT max(c.check_number) AS n
    FROM public.vendor_checks c
    WHERE c.bank_account_netsuite_id = p_account
    UNION ALL
    SELECT max(t.n)
    FROM (
      SELECT x.netsuite_id, CASE WHEN x.tranid ~ '^[0-9]{1,8}$' THEN x.tranid::bigint END AS n
      FROM public.gl_netsuite_transactions x
      WHERE x.tran_type IN ('Check', 'VendPymt', 'CustRfnd')
    ) AS t
    WHERE EXISTS (SELECT 1 FROM public.gl_netsuite_lines l WHERE l.transaction_id = t.netsuite_id AND l.netsuite_account_id = p_account)
  ) AS u;
$$;

-- Takes check numbers for a run's checks, all or none, before FleetSuite sets them in NetSuite. p:
--   { run_id, by, checks: [{ payment_id, number, printed_as }] }
-- Each payment is one of the run's checks made in NetSuite with no check that isn't spoiled, and each number is free
-- on the run's bank account among FleetSuite's checks (the route checks NetSuite's first). Answers { state }:
--   'claimed'    each one is numbering (checks: [{ id, payment_id, number }], by number);
--   'not_made'   payments that aren't the run's checks made in NetSuite;
--   'has_check'  payments that have a check already;
--   'taken'      numbers used already on the bank account;
--   'gone'       there's no such run, or it isn't approved or done.
CREATE OR REPLACE FUNCTION public.vendor_checks_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_checks JSONB := coalesce(p->'checks', '[]'::jsonb);
  v_run public.vendor_payment_runs;
  v_bad TEXT[];
  v_taken BIGINT[];
  v_out JSONB;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'vendor checks: numbering checks needs who numbered them';
  END IF;
  IF jsonb_typeof(v_checks) IS DISTINCT FROM 'array' OR jsonb_array_length(v_checks) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'vendor checks: number 1 to 50 checks at a time';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_checks) AS x(v)
    WHERE jsonb_typeof(x.v) IS DISTINCT FROM 'object'
       OR coalesce(x.v->>'payment_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(x.v->'number') IS DISTINCT FROM 'number'
       OR (x.v->>'number')::numeric <> trunc((x.v->>'number')::numeric)
       OR (x.v->>'number')::numeric NOT BETWEEN 1 AND 99999999
       OR jsonb_typeof(x.v->'printed_as') IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'vendor checks: each check is a payment, a whole number from 1 to 99,999,999, and what''s printed on it';
  END IF;
  IF (SELECT count(DISTINCT (x.v->>'payment_id')::uuid) FROM jsonb_array_elements(v_checks) AS x(v)) <> jsonb_array_length(v_checks)
     OR (SELECT count(DISTINCT (x.v->>'number')::bigint) FROM jsonb_array_elements(v_checks) AS x(v)) <> jsonb_array_length(v_checks) THEN
    RAISE EXCEPTION 'vendor checks: each payment and each number once';
  END IF;

  -- One numbering at a time, so two never take the same number or the same payment.
  LOCK TABLE public.vendor_checks IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_run FROM public.vendor_payment_runs WHERE id = (p->>'run_id')::uuid;
  IF NOT FOUND OR v_run.status NOT IN ('approved', 'done') OR v_run.bank_account_netsuite_id IS NULL THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;

  SELECT coalesce(array_agg(x.v->>'payment_id' ORDER BY x.n), ARRAY[]::TEXT[]) INTO v_bad
  FROM jsonb_array_elements(v_checks) WITH ORDINALITY AS x(v, n)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.vendor_payment_run_payments pay
    WHERE pay.id = (x.v->>'payment_id')::uuid AND pay.run_id = v_run.id AND pay.method = 'check' AND pay.status = 'made'
  );
  IF cardinality(v_bad) > 0 THEN
    RETURN jsonb_build_object('state', 'not_made', 'payments', to_jsonb(v_bad));
  END IF;

  SELECT coalesce(array_agg(x.v->>'payment_id' ORDER BY x.n), ARRAY[]::TEXT[]) INTO v_bad
  FROM jsonb_array_elements(v_checks) WITH ORDINALITY AS x(v, n)
  WHERE EXISTS (SELECT 1 FROM public.vendor_checks c WHERE c.payment_id = (x.v->>'payment_id')::uuid AND c.status <> 'spoiled');
  IF cardinality(v_bad) > 0 THEN
    RETURN jsonb_build_object('state', 'has_check', 'payments', to_jsonb(v_bad));
  END IF;

  SELECT coalesce(array_agg(c.check_number ORDER BY c.check_number), ARRAY[]::BIGINT[]) INTO v_taken
  FROM public.vendor_checks c
  WHERE c.bank_account_netsuite_id = v_run.bank_account_netsuite_id
    AND c.check_number IN (SELECT (x.v->>'number')::bigint FROM jsonb_array_elements(v_checks) AS x(v));
  IF cardinality(v_taken) > 0 THEN
    RETURN jsonb_build_object('state', 'taken', 'numbers', to_jsonb(v_taken));
  END IF;

  WITH taken AS (
    INSERT INTO public.vendor_checks (
      company, bank_account_netsuite_id, check_number, run_id, payment_id, netsuite_payment_id, status, printed_as, numbered_by
    )
    SELECT v_run.company, v_run.bank_account_netsuite_id, (x.v->>'number')::bigint, v_run.id, pay.id, pay.netsuite_payment_id,
           'numbering', x.v->'printed_as', (p->>'by')::uuid
    FROM jsonb_array_elements(v_checks) AS x(v)
    JOIN public.vendor_payment_run_payments pay ON pay.id = (x.v->>'payment_id')::uuid
    RETURNING id, payment_id, check_number
  )
  SELECT jsonb_agg(jsonb_build_object('id', taken.id, 'payment_id', taken.payment_id, 'number', taken.check_number) ORDER BY taken.check_number)
  INTO v_out
  FROM taken;
  RETURN jsonb_build_object('state', 'claimed', 'checks', v_out);
END;
$$;

-- NetSuite took the number: the check is numbered, and its number is the payment's and Books' copy's. p: { id }.
-- Returns { numbered } — false when it isn't numbering (numbered already, or let go).
CREATE OR REPLACE FUNCTION public.vendor_check_numbered(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_checks;
BEGIN
  UPDATE public.vendor_checks
  SET status = 'numbered', error = NULL, updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'numbering'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('numbered', false);
  END IF;
  UPDATE public.vendor_payment_run_payments SET netsuite_number = v_row.check_number::text, updated_at = now() WHERE id = v_row.payment_id;
  UPDATE public.gl_own_bill_payments SET netsuite_number = v_row.check_number::text WHERE netsuite_id = v_row.netsuite_payment_id;
  RETURN jsonb_build_object('numbered', true);
END;
$$;

-- NetSuite didn't take the number, or said it didn't when asked: the number is free again. p: { id }.
-- Returns { let_go } — false when it isn't numbering.
CREATE OR REPLACE FUNCTION public.vendor_check_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.vendor_checks WHERE id = (p->>'id')::uuid AND status = 'numbering';
  RETURN jsonb_build_object('let_go', FOUND);
END;
$$;

-- These numbered checks printed right. p: { ids, by }. Returns { printed } — how many were numbered and now printed.
CREATE OR REPLACE FUNCTION public.vendor_checks_printed(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'vendor checks: printing checks needs who printed them';
  END IF;
  IF jsonb_typeof(p->'ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'ids') NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'vendor checks: mark 1 to 50 checks printed at a time';
  END IF;
  UPDATE public.vendor_checks
  SET status = 'printed', printed_by = (p->>'by')::uuid, printed_at = now(), updated_at = now()
  WHERE id IN (SELECT (x.v #>> '{}')::uuid FROM jsonb_array_elements(p->'ids') AS x(v)) AND status = 'numbered';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('printed', v_count);
END;
$$;

-- A check FleetSuite numbered didn't print right: it keeps its number, with why, and its payment can take another.
-- p: { id, by, reason }. Answers { state }: 'spoiled', or where it is ('numbering', 'printed_in_netsuite',
-- 'already_spoiled', 'gone').
CREATE OR REPLACE FUNCTION public.vendor_check_spoil(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_reason TEXT := nullif(btrim(coalesce(p->>'reason', '')), '');
  v_row public.vendor_checks;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'vendor checks: a spoiled check needs who spoiled it';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'vendor checks: a spoiled check needs why it didn''t print right';
  END IF;
  SELECT * INTO v_row FROM public.vendor_checks WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status NOT IN ('numbered', 'printed') THEN
    RETURN jsonb_build_object('state', CASE v_row.status WHEN 'spoiled' THEN 'already_spoiled' ELSE v_row.status END);
  END IF;
  UPDATE public.vendor_checks
  SET status = 'spoiled', spoiled_by = (p->>'by')::uuid, spoiled_at = now(), spoiled_reason = left(v_reason, 300), updated_at = now()
  WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'spoiled');
END;
$$;

-- A run's check printed from NetSuite before FleetSuite numbered it: kept with NetSuite's number, which is the
-- payment's and Books' copy's. p: { run_id, payment_id, number, by }. Answers { state }: 'kept', or 'not_made',
-- 'has_check', 'taken' (FleetSuite used that number on the bank account already) or 'gone', as vendor_checks_claim.
CREATE OR REPLACE FUNCTION public.vendor_check_printed_in_netsuite(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_run public.vendor_payment_runs;
  v_pay public.vendor_payment_run_payments;
  v_number BIGINT;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'vendor checks: keeping a check printed in NetSuite needs who found it';
  END IF;
  IF jsonb_typeof(p->'number') IS DISTINCT FROM 'number' OR (p->>'number')::numeric <> trunc((p->>'number')::numeric)
     OR (p->>'number')::numeric NOT BETWEEN 1 AND 99999999 THEN
    RAISE EXCEPTION 'vendor checks: a check number is a whole number from 1 to 99,999,999';
  END IF;
  v_number := (p->>'number')::bigint;
  LOCK TABLE public.vendor_checks IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_run FROM public.vendor_payment_runs WHERE id = (p->>'run_id')::uuid;
  IF NOT FOUND OR v_run.status NOT IN ('approved', 'done') OR v_run.bank_account_netsuite_id IS NULL THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  SELECT * INTO v_pay FROM public.vendor_payment_run_payments
  WHERE id = (p->>'payment_id')::uuid AND run_id = v_run.id AND method = 'check' AND status = 'made';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'not_made');
  END IF;
  IF EXISTS (SELECT 1 FROM public.vendor_checks c WHERE c.payment_id = v_pay.id AND c.status <> 'spoiled') THEN
    RETURN jsonb_build_object('state', 'has_check');
  END IF;
  IF EXISTS (SELECT 1 FROM public.vendor_checks c WHERE c.bank_account_netsuite_id = v_run.bank_account_netsuite_id AND c.check_number = v_number) THEN
    RETURN jsonb_build_object('state', 'taken');
  END IF;

  INSERT INTO public.vendor_checks (company, bank_account_netsuite_id, check_number, run_id, payment_id, netsuite_payment_id, status, numbered_by)
  VALUES (v_run.company, v_run.bank_account_netsuite_id, v_number, v_run.id, v_pay.id, v_pay.netsuite_payment_id, 'printed_in_netsuite',
          (p->>'by')::uuid);
  UPDATE public.vendor_payment_run_payments SET netsuite_number = v_number::text, updated_at = now() WHERE id = v_pay.id;
  UPDATE public.gl_own_bill_payments SET netsuite_number = v_number::text WHERE netsuite_id = v_pay.netsuite_payment_id;
  RETURN jsonb_build_object('state', 'kept');
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_check_layouts', 'vendor_checks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.vendor_check_numbers_used(text, bigint, bigint)', 'public.vendor_check_last_number(text)',
                           'public.vendor_checks_claim(jsonb)', 'public.vendor_check_numbered(jsonb)',
                           'public.vendor_check_let_go(jsonb)', 'public.vendor_checks_printed(jsonb)',
                           'public.vendor_check_spoil(jsonb)', 'public.vendor_check_printed_in_netsuite(jsonb)'] LOOP
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

COMMENT ON TABLE vendor_check_layouts IS 'Migration 489: where each bank account''s checks print on its pre-printed stock (src/lib/check-printing.ts, /api/pay-vendors/checks): the check''s part of the sheet, and how far the print moves right and down in sixteenths of an inch. Service-role write and read.';
COMMENT ON TABLE vendor_checks IS 'Migration 489: one row per check number FleetSuite gives on a bank account, never the same one twice: a payment run''s check numbering in NetSuite, numbered, printed, spoiled with why (its number kept), or printed from NetSuite with NetSuite''s number; one at a time per payment that isn''t spoiled. Moved only by its functions and the route''s note of an answer NetSuite didn''t give. Service-role write and read.';
COMMENT ON FUNCTION public.vendor_check_numbers_used(text, bigint, bigint) IS 'Migration 489: the check numbers in a range used already on a bank account, by FleetSuite''s checks or by checks, bill payments and refunds in NetSuite''s copy. Service role only.';
COMMENT ON FUNCTION public.vendor_check_last_number(text) IS 'Migration 489: the highest check number used on a bank account, by FleetSuite''s checks or in NetSuite''s copy. Service role only.';
COMMENT ON FUNCTION public.vendor_checks_claim(jsonb) IS 'Migration 489: takes check numbers for a run''s checks made in NetSuite, all or none, each number free on the bank account and each payment with no check that isn''t spoiled. Service role only.';
COMMENT ON FUNCTION public.vendor_check_numbered(jsonb) IS 'Migration 489: NetSuite took a check''s number; the payment and Books'' copy of the bill payment take it as NetSuite''s number. Service role only.';
COMMENT ON FUNCTION public.vendor_check_let_go(jsonb) IS 'Migration 489: frees a check number NetSuite didn''t take. Service role only.';
COMMENT ON FUNCTION public.vendor_checks_printed(jsonb) IS 'Migration 489: marks numbered checks printed. Service role only.';
COMMENT ON FUNCTION public.vendor_check_spoil(jsonb) IS 'Migration 489: a numbered or printed check didn''t print right: it keeps its number with why, and its payment can take another. Service role only.';
COMMENT ON FUNCTION public.vendor_check_printed_in_netsuite(jsonb) IS 'Migration 489: keeps a run''s check printed from NetSuite with NetSuite''s number. Service role only.';
COMMENT ON TABLE gl_own_bill_payments IS 'Migration 488: Books'' own copy of each bill payment FleetSuite makes in NetSuite, saved only by gl_own_bill_payment_save, by NetSuite''s id for it; its number is the check''s once FleetSuite numbers it (migration 489). Not checked against NetSuite''s or posted yet. Service-role write and read.';
