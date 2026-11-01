-- Migration 486: FleetSuite's own books, part 55 — customer deposits taken in
-- FleetSuite on a sales order, by check or ACH, and sent on to NetSuite,
-- switched off.
--
-- Owner decisions (thread "Replacing NetSuite with FleetSuite"): receiving
-- and making payments, deposits and banking stay in NetSuite on January 1,
-- 2027 and move into FleetSuite during 2027, each before its move, with
-- FleetSuite sending each on to NetSuite so nobody types anything twice
-- (2026-10-31). After payments on invoices (part 54) come deposits on
-- estimates and orders. A sales order's Deposit button, or an estimate's once
-- it has its sales order, takes the customer's check or ACH deposit, and
-- FleetSuite makes the customer deposit in NetSuite on that order, in
-- Undeposited Funds as payments go now, once (src/lib/take-deposit.ts,
-- /api/sales-orders/deposit, page /sales-orders/deposit, docs/books.md
-- "Deposits taken in FleetSuite"). NetSuite puts an order's deposit on the
-- order's invoice when the order's billed, as it does now.
--
--   * books_switches takes a thirteenth piece, customer_deposits, off. It
--     stays off past January 1, until taking deposits moves into FleetSuite;
--   * received_deposits, one row per press of Take deposit. Its id comes from
--     the page and is the deposit's External ID in NetSuite ('fleetsuite-cd-'
--     and the id), so pressing it again never takes a second deposit. It goes
--     sending (being made in NetSuite) → made, or back to open with NetSuite's
--     reason when NetSuite doesn't make it, so the same form can be sent
--     again;
--   * gl_own_deposits, Books' own copy of each deposit FleetSuite makes,
--     written only by gl_own_deposit_save; saving the same NetSuite deposit
--     again changes nothing. Checking the copies against NetSuite's, and
--     posting them, comes after.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 485 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all thirteen.
DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%piece%'
  LOOP
    EXECUTE format('ALTER TABLE public.books_switches DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE books_switches ADD CONSTRAINT books_switches_piece_check
  CHECK (piece IN ('credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes',
                   'bill_fixes', 'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records',
                   'customer_payments', 'customer_deposits'));

INSERT INTO books_switches (piece) VALUES ('customer_deposits') ON CONFLICT (piece) DO NOTHING;

-- ── Each press of Take deposit ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS received_deposits (
  -- Made by the page when it opens; its External ID in NetSuite is 'fleetsuite-cd-' and this.
  id UUID PRIMARY KEY,
  -- The company whose sales order it's on.
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  customer_netsuite_id TEXT NOT NULL CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_name TEXT CHECK (length(customer_name) <= 300),
  -- The sales order it's a deposit on.
  sales_order_netsuite_id TEXT NOT NULL CHECK (sales_order_netsuite_id ~ '^[0-9]+$'),
  sales_order_number TEXT CHECK (length(sales_order_number) <= 60),
  received_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('check', 'ach')),
  -- The check's number, or the ACH payment's reference; a check always has one.
  reference TEXT CHECK (length(reference) <= 40),
  memo TEXT CHECK (length(memo) <= 300),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('open', 'sending', 'made')),
  -- The press that's making it in NetSuite, or made it.
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  netsuite_deposit_id TEXT CHECK (netsuite_deposit_id ~ '^[0-9]+$'),
  netsuite_number TEXT,
  -- Why NetSuite didn't make it, or why FleetSuite can't tell, the last time it was sent.
  error TEXT CHECK (length(error) <= 2000),
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'made') = (netsuite_deposit_id IS NOT NULL)),
  CHECK (status <> 'sending' OR sent_at IS NOT NULL),
  CHECK (method <> 'check' OR btrim(coalesce(reference, '')) <> '')
);
CREATE INDEX IF NOT EXISTS received_deposits_order_idx ON received_deposits (sales_order_netsuite_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS received_deposits_customer_idx ON received_deposits (customer_netsuite_id, created_at DESC, id);

-- Takes the claim for a press of Take deposit. p:
--   { id, by, company, customer_netsuite_id, customer_name?, sales_order_netsuite_id, sales_order_number?,
--     received_date, method, reference?, memo?, amount_cents }
-- The route works the deposit out from the order as NetSuite has it first (src/lib/take-deposit.ts).
-- Answers { state } with:
--   'made'     it's in NetSuite already (netsuite_deposit_id, netsuite_number);
--   'sending'  a press holds it and is making it, or NetSuite hasn't said whether it did (deposit);
--   'claimed'  this press now holds it, as sent now (deposit).
-- A press NetSuite refused lets go of it (received_deposit_let_go), and the same form can be sent again.
CREATE OR REPLACE FUNCTION public.received_deposit_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_amount BIGINT;
  v_method TEXT := btrim(coalesce(p->>'method', ''));
  v_reference TEXT := nullif(btrim(coalesce(p->>'reference', '')), '');
  v_row public.received_deposits;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'deposits: a send needs who sent it';
  END IF;
  IF jsonb_typeof(p->'amount_cents') IS DISTINCT FROM 'number' OR (p->>'amount_cents')::numeric <> round((p->>'amount_cents')::numeric)
     OR (p->>'amount_cents')::numeric <= 0 THEN
    RAISE EXCEPTION 'deposits: a deposit''s amount is a whole number of cents above 0';
  END IF;
  v_amount := (p->>'amount_cents')::bigint;
  IF coalesce(p->>'sales_order_netsuite_id', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'deposits: a deposit goes on a sales order, by NetSuite''s id for it';
  END IF;
  IF v_method NOT IN ('check', 'ach') THEN
    RAISE EXCEPTION 'deposits: a deposit is a check or an ACH payment';
  END IF;
  IF v_method = 'check' AND v_reference IS NULL THEN
    RAISE EXCEPTION 'deposits: a check needs its number';
  END IF;

  INSERT INTO public.received_deposits (
    id, company, customer_netsuite_id, customer_name, sales_order_netsuite_id, sales_order_number, received_date, method,
    reference, memo, amount_cents, status, sent_by, sent_at, created_by
  ) VALUES (
    v_id, btrim(p->>'company'), p->>'customer_netsuite_id', nullif(btrim(coalesce(p->>'customer_name', '')), ''),
    p->>'sales_order_netsuite_id', nullif(btrim(coalesce(p->>'sales_order_number', '')), ''), (p->>'received_date')::date,
    v_method, v_reference, nullif(btrim(coalesce(p->>'memo', '')), ''), v_amount, 'sending', (p->>'by')::uuid, now(),
    (p->>'by')::uuid
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'claimed', 'deposit', to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.received_deposits WHERE id = v_id FOR UPDATE;
  IF v_row.status = 'made' THEN
    RETURN jsonb_build_object('state', 'made', 'netsuite_deposit_id', v_row.netsuite_deposit_id, 'netsuite_number', v_row.netsuite_number);
  END IF;
  IF v_row.status = 'sending' THEN
    RETURN jsonb_build_object('state', 'sending', 'deposit', to_jsonb(v_row));
  END IF;

  -- Let go after NetSuite refused it: sent again, as it's sent now.
  UPDATE public.received_deposits
  SET company = btrim(p->>'company'), customer_netsuite_id = p->>'customer_netsuite_id',
      customer_name = nullif(btrim(coalesce(p->>'customer_name', '')), ''),
      sales_order_netsuite_id = p->>'sales_order_netsuite_id',
      sales_order_number = nullif(btrim(coalesce(p->>'sales_order_number', '')), ''), received_date = (p->>'received_date')::date,
      method = v_method, reference = v_reference, memo = nullif(btrim(coalesce(p->>'memo', '')), ''),
      amount_cents = v_amount, status = 'sending', sent_by = (p->>'by')::uuid, sent_at = now(), error = NULL, updated_at = now()
  WHERE id = v_id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'claimed', 'deposit', to_jsonb(v_row));
END;
$$;

-- Lets go of a press that didn't make the deposit, keeping why, so the same form can be sent again. p: { id, error }.
-- Returns { let_go }.
CREATE OR REPLACE FUNCTION public.received_deposit_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.received_deposits
  SET status = 'open', sent_by = NULL, sent_at = NULL,
      error = left(coalesce(nullif(btrim(p->>'error'), ''), 'Not made'), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('let_go', FOUND);
END;
$$;

-- Keeps the deposit NetSuite made for a press. p: { id, netsuite_deposit_id, netsuite_number? }.
-- Returns { made } — false when the deposit isn't being made (made already, or let go).
CREATE OR REPLACE FUNCTION public.received_deposit_made(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(p->>'netsuite_deposit_id', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'deposits: a made deposit needs NetSuite''s id for it';
  END IF;
  UPDATE public.received_deposits
  SET status = 'made', netsuite_deposit_id = p->>'netsuite_deposit_id', netsuite_number = nullif(btrim(p->>'netsuite_number'), ''),
      error = NULL, updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('made', FOUND);
END;
$$;

-- ── Books' own copy ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_deposits (
  -- NetSuite's internal id for the customer deposit FleetSuite made; the books' copy of it is gl_netsuite_deposits'.
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_number TEXT,
  -- The press of Take deposit that made it (received_deposits).
  made_from_id UUID,
  customer_netsuite_id TEXT NOT NULL CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- The sales order it's a deposit on.
  sales_order_netsuite_id TEXT NOT NULL CHECK (sales_order_netsuite_id ~ '^[0-9]+$'),
  sales_order_number TEXT,
  -- The day it was received, as typed.
  deposit_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('check', 'ach')),
  reference TEXT,
  memo TEXT,
  -- Where the money went: Undeposited Funds, until a bank deposit moves it to the bank.
  deposited_to TEXT NOT NULL CHECK (deposited_to IN ('undeposited_funds')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_own_deposits_date ON gl_own_deposits(deposit_date DESC, netsuite_id);
CREATE INDEX IF NOT EXISTS idx_gl_own_deposits_order ON gl_own_deposits(sales_order_netsuite_id);

-- Saves Books' own copy of a deposit FleetSuite just made. p:
--   { netsuite_id, netsuite_number?, company ('BMG' or '1084'), made_from_id?, customer_netsuite_id, customer_id?,
--     sales_order_netsuite_id, sales_order_number?, deposit_date, method, reference?, memo?, deposited_to, amount,
--     made_by? }
-- A copy of that deposit already saved stays as it is. Returns { saved }.
CREATE OR REPLACE FUNCTION public.gl_own_deposit_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id TEXT := p->>'netsuite_id';
  v_company UUID;
  v_inserted INTEGER;
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: an own deposit needs NetSuite''s id for the deposit';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = p->>'company';
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(p->>'company', '(none)');
  END IF;

  INSERT INTO public.gl_own_deposits (
    netsuite_id, company_id, netsuite_number, made_from_id, customer_netsuite_id, customer_id, sales_order_netsuite_id,
    sales_order_number, deposit_date, method, reference, memo, deposited_to, amount, made_by
  ) VALUES (
    v_id, v_company, nullif(btrim(p->>'netsuite_number'), ''), nullif(p->>'made_from_id', '')::uuid,
    p->>'customer_netsuite_id', nullif(p->>'customer_id', '')::uuid, p->>'sales_order_netsuite_id',
    nullif(btrim(coalesce(p->>'sales_order_number', '')), ''), (p->>'deposit_date')::date, p->>'method',
    nullif(btrim(coalesce(p->>'reference', '')), ''), nullif(btrim(coalesce(p->>'memo', '')), ''), p->>'deposited_to',
    (p->>'amount')::numeric, nullif(p->>'made_by', '')::uuid
  )
  ON CONFLICT (netsuite_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN jsonb_build_object('saved', v_inserted > 0);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['received_deposits', 'gl_own_deposits'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.received_deposit_claim(jsonb)', 'public.received_deposit_let_go(jsonb)',
                           'public.received_deposit_made(jsonb)', 'public.gl_own_deposit_save(jsonb)'] LOOP
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

COMMENT ON TABLE received_deposits IS 'Migration 486: one row per press of Take deposit (src/lib/take-deposit.ts, /api/sales-orders/deposit): the customer''s check or ACH deposit, the sales order it''s on, who sent it, and the deposit NetSuite made (its External ID is fleetsuite-cd- and this id) or why it didn''t. Moved only by its functions and the route''s note of an answer NetSuite didn''t give. Service-role write and read.';
COMMENT ON FUNCTION public.received_deposit_claim(jsonb) IS 'Migration 486: takes the claim for a press of Take deposit, or says what became of the press before it. Service role only.';
COMMENT ON FUNCTION public.received_deposit_let_go(jsonb) IS 'Migration 486: lets go of a press NetSuite didn''t make, keeping why, so the same form can be sent again. Service role only.';
COMMENT ON FUNCTION public.received_deposit_made(jsonb) IS 'Migration 486: keeps the deposit NetSuite made for a press. Service role only.';
COMMENT ON TABLE gl_own_deposits IS 'Migration 486: Books'' own copy of each customer deposit FleetSuite makes in NetSuite, saved only by gl_own_deposit_save, by NetSuite''s id for the deposit. Not checked against NetSuite''s or posted yet. Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_deposit_save(jsonb) IS 'Migration 486: saves Books'' own copy of a deposit FleetSuite just made; one already saved stays as it is. Service role only.';
