-- Migration 485: FleetSuite's own books, part 54 — customer payments received
-- in FleetSuite, by check or ACH, and sent on to NetSuite, switched off.
--
-- Owner decisions (thread "Replacing NetSuite with FleetSuite"): receiving
-- and making payments, deposits and banking stay in NetSuite on January 1,
-- 2027 and move into FleetSuite during 2027, each before its move, with
-- FleetSuite sending each on to NetSuite so nobody types anything twice
-- (2026-10-31). Receiving a check or an ACH payment comes first; card
-- payments wait on eBizCharge. From an open invoice in Invoicing → Invoiced,
-- Payment takes the customer's check or ACH payment: its amount, applied to
-- that customer's open invoices, and FleetSuite makes the customer payment in
-- NetSuite, in Undeposited Funds as payments go now, once
-- (src/lib/receive-payment.ts, /api/invoices/payment, page /invoices/payment,
-- docs/books.md "Payments received in FleetSuite").
--
--   * books_switches takes a twelfth piece, customer_payments, off. It stays
--     off past January 1, until receiving payments moves into FleetSuite;
--   * received_payments, one row per press of Receive payment. Its id comes
--     from the page and is the payment's External ID in NetSuite
--     ('fleetsuite-cp-' and the id), so pressing it again never makes a
--     second payment. It goes sending (being made in NetSuite) → made, or
--     back to open with NetSuite's reason when NetSuite doesn't make it, so
--     the same form can be sent again;
--   * gl_own_payments and gl_own_payment_applications, Books' own copy of each
--     payment FleetSuite makes, written only by gl_own_payment_save, which
--     keeps each one whole: what it applies adds up to its amount, and saving
--     the same NetSuite payment again changes nothing. Checking the copies
--     against NetSuite's, and posting them, comes after.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 480 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all twelve.
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
                   'customer_payments'));

INSERT INTO books_switches (piece) VALUES ('customer_payments') ON CONFLICT (piece) DO NOTHING;

-- ── Each press of Receive payment ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS received_payments (
  -- Made by the page when it opens; its External ID in NetSuite is 'fleetsuite-cp-' and this.
  id UUID PRIMARY KEY,
  -- The company whose invoices it pays: a payment pays one company's.
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  customer_netsuite_id TEXT NOT NULL CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_name TEXT CHECK (length(customer_name) <= 300),
  -- The invoice Payment was pressed on.
  started_from_invoice_id TEXT CHECK (started_from_invoice_id ~ '^[0-9]+$'),
  received_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('check', 'ach')),
  -- The check's number, or the ACH payment's reference; a check always has one.
  reference TEXT CHECK (length(reference) <= 40),
  memo TEXT CHECK (length(memo) <= 300),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  -- What it pays, as sent, in order: [{ invoice_netsuite_id, invoice_number, cents }].
  applied JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(applied) = 'array'),
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('open', 'sending', 'made')),
  -- The press that's making it in NetSuite, or made it.
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  netsuite_payment_id TEXT CHECK (netsuite_payment_id ~ '^[0-9]+$'),
  netsuite_number TEXT,
  -- Why NetSuite didn't make it, or why FleetSuite can't tell, the last time it was sent.
  error TEXT CHECK (length(error) <= 2000),
  -- Made, but what NetSuite shows open on its invoices afterwards isn't what FleetSuite sent.
  warning TEXT CHECK (length(warning) <= 2000),
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'made') = (netsuite_payment_id IS NOT NULL)),
  CHECK (status <> 'sending' OR sent_at IS NOT NULL),
  CHECK (method <> 'check' OR btrim(coalesce(reference, '')) <> '')
);
CREATE INDEX IF NOT EXISTS received_payments_customer_idx ON received_payments (customer_netsuite_id, created_at DESC, id);

-- Takes the claim for a press of Receive payment. p:
--   { id, by, company, customer_netsuite_id, customer_name?, started_from_invoice_id?, received_date, method,
--     reference?, memo?, amount_cents, applied: [{ invoice_netsuite_id, invoice_number?, cents }] }
-- The route works the payment out from what NetSuite has open first (src/lib/receive-payment.ts); here it must be
-- whole: one invoice or more, 50 at most, each once and paid more than $0, adding up to the amount.
-- Answers { state } with:
--   'made'     it's in NetSuite already (netsuite_payment_id, netsuite_number);
--   'sending'  a press holds it and is making it, or NetSuite hasn't said whether it did (payment);
--   'claimed'  this press now holds it, as sent now (payment).
-- A press NetSuite refused lets go of it (received_payment_let_go), and the same form can be sent again.
CREATE OR REPLACE FUNCTION public.received_payment_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_applied JSONB := coalesce(p->'applied', '[]'::jsonb);
  v_kept JSONB;
  v_amount BIGINT;
  v_sum NUMERIC;
  v_method TEXT := btrim(coalesce(p->>'method', ''));
  v_reference TEXT := nullif(btrim(coalesce(p->>'reference', '')), '');
  v_row public.received_payments;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'payments: a send needs who sent it';
  END IF;
  IF jsonb_typeof(p->'amount_cents') IS DISTINCT FROM 'number' OR (p->>'amount_cents')::numeric <> round((p->>'amount_cents')::numeric)
     OR (p->>'amount_cents')::numeric <= 0 THEN
    RAISE EXCEPTION 'payments: a payment''s amount is a whole number of cents above 0';
  END IF;
  v_amount := (p->>'amount_cents')::bigint;
  IF jsonb_typeof(v_applied) IS DISTINCT FROM 'array' OR jsonb_array_length(v_applied) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'payments: a payment pays one invoice or more, 50 at most';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_applied) AS x(v)
    WHERE jsonb_typeof(x.v) IS DISTINCT FROM 'object'
       OR coalesce(x.v->>'invoice_netsuite_id', '') !~ '^[0-9]+$'
       OR jsonb_typeof(x.v->'cents') IS DISTINCT FROM 'number'
       OR (x.v->>'cents')::numeric <> round((x.v->>'cents')::numeric)
       OR (x.v->>'cents')::numeric <= 0
       OR length(coalesce(x.v->>'invoice_number', '')) > 60
  ) THEN
    RAISE EXCEPTION 'payments: each invoice it pays is NetSuite''s id for it and a whole number of cents above 0';
  END IF;
  IF (SELECT count(DISTINCT x.v->>'invoice_netsuite_id') FROM jsonb_array_elements(v_applied) AS x(v)) <> jsonb_array_length(v_applied) THEN
    RAISE EXCEPTION 'payments: a payment pays each invoice once';
  END IF;
  SELECT sum((x.v->>'cents')::numeric) INTO v_sum FROM jsonb_array_elements(v_applied) AS x(v);
  IF v_sum <> v_amount THEN
    RAISE EXCEPTION 'payments: what a payment pays must add up to its amount';
  END IF;
  IF v_method NOT IN ('check', 'ach') THEN
    RAISE EXCEPTION 'payments: a payment is a check or an ACH payment';
  END IF;
  IF v_method = 'check' AND v_reference IS NULL THEN
    RAISE EXCEPTION 'payments: a check needs its number';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'invoice_netsuite_id', x.v->>'invoice_netsuite_id',
           'invoice_number', nullif(btrim(coalesce(x.v->>'invoice_number', '')), ''),
           'cents', (x.v->>'cents')::bigint
         ) ORDER BY x.n)
  INTO v_kept
  FROM jsonb_array_elements(v_applied) WITH ORDINALITY AS x(v, n);

  INSERT INTO public.received_payments (
    id, company, customer_netsuite_id, customer_name, started_from_invoice_id, received_date, method, reference, memo,
    amount_cents, applied, status, sent_by, sent_at, created_by
  ) VALUES (
    v_id, btrim(p->>'company'), p->>'customer_netsuite_id', nullif(btrim(coalesce(p->>'customer_name', '')), ''),
    nullif(p->>'started_from_invoice_id', ''), (p->>'received_date')::date, v_method, v_reference,
    nullif(btrim(coalesce(p->>'memo', '')), ''), v_amount, v_kept, 'sending', (p->>'by')::uuid, now(), (p->>'by')::uuid
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'claimed', 'payment', to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.received_payments WHERE id = v_id FOR UPDATE;
  IF v_row.status = 'made' THEN
    RETURN jsonb_build_object('state', 'made', 'netsuite_payment_id', v_row.netsuite_payment_id, 'netsuite_number', v_row.netsuite_number);
  END IF;
  IF v_row.status = 'sending' THEN
    RETURN jsonb_build_object('state', 'sending', 'payment', to_jsonb(v_row));
  END IF;

  -- Let go after NetSuite refused it: sent again, as it's sent now.
  UPDATE public.received_payments
  SET company = btrim(p->>'company'), customer_netsuite_id = p->>'customer_netsuite_id',
      customer_name = nullif(btrim(coalesce(p->>'customer_name', '')), ''),
      started_from_invoice_id = nullif(p->>'started_from_invoice_id', ''), received_date = (p->>'received_date')::date,
      method = v_method, reference = v_reference, memo = nullif(btrim(coalesce(p->>'memo', '')), ''),
      amount_cents = v_amount, applied = v_kept, status = 'sending', sent_by = (p->>'by')::uuid, sent_at = now(),
      error = NULL, updated_at = now()
  WHERE id = v_id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'claimed', 'payment', to_jsonb(v_row));
END;
$$;

-- Lets go of a press that didn't make the payment, keeping why, so the same form can be sent again. p: { id, error }.
-- Returns { let_go }.
CREATE OR REPLACE FUNCTION public.received_payment_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.received_payments
  SET status = 'open', sent_by = NULL, sent_at = NULL,
      error = left(coalesce(nullif(btrim(p->>'error'), ''), 'Not made'), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('let_go', FOUND);
END;
$$;

-- Keeps the payment NetSuite made for a press. p: { id, netsuite_payment_id, netsuite_number?, warning? }.
-- Returns { made } — false when the payment isn't being made (made already, or let go).
CREATE OR REPLACE FUNCTION public.received_payment_made(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(p->>'netsuite_payment_id', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'payments: a made payment needs NetSuite''s id for it';
  END IF;
  UPDATE public.received_payments
  SET status = 'made', netsuite_payment_id = p->>'netsuite_payment_id', netsuite_number = nullif(btrim(p->>'netsuite_number'), ''),
      error = NULL, warning = left(nullif(btrim(coalesce(p->>'warning', '')), ''), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('made', FOUND);
END;
$$;

-- ── Books' own copy ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_payments (
  -- NetSuite's internal id for the payment FleetSuite made; the ledger mirror's copy of it is 'CustPymt/<id>'.
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_number TEXT,
  -- The press of Receive payment that made it (received_payments).
  made_from_id UUID,
  customer_netsuite_id TEXT NOT NULL CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- The day it was received, as typed.
  payment_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('check', 'ach')),
  reference TEXT,
  memo TEXT,
  -- Where the money went: Undeposited Funds, until a bank deposit moves it to the bank.
  deposited_to TEXT NOT NULL CHECK (deposited_to IN ('undeposited_funds')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_own_payments_date ON gl_own_payments(payment_date DESC, netsuite_id);

CREATE TABLE IF NOT EXISTS gl_own_payment_applications (
  payment_id TEXT NOT NULL REFERENCES gl_own_payments(netsuite_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  -- The invoice it pays.
  invoice_netsuite_id TEXT NOT NULL CHECK (invoice_netsuite_id ~ '^[0-9]+$'),
  invoice_number TEXT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, line_no),
  UNIQUE (payment_id, invoice_netsuite_id)
);
CREATE INDEX IF NOT EXISTS idx_gl_own_payment_applications_invoice ON gl_own_payment_applications(invoice_netsuite_id);

-- Saves Books' own copy of a payment FleetSuite just made. p:
--   { netsuite_id, netsuite_number?, company ('BMG' or '1084'), made_from_id?, customer_netsuite_id, customer_id?,
--     payment_date, method, reference?, memo?, deposited_to, amount, made_by?,
--     applications: [{ line_no, invoice_netsuite_id, invoice_number?, amount }] }
-- What it applies must add up to its amount. A copy of that payment already saved stays as it is. Returns
-- { saved, lines }.
CREATE OR REPLACE FUNCTION public.gl_own_payment_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id TEXT := p->>'netsuite_id';
  v_company UUID;
  v_lines JSONB := coalesce(p->'applications', '[]'::jsonb);
  v_sum NUMERIC;
  v_inserted INTEGER;
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: an own payment needs NetSuite''s id for the payment';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = p->>'company';
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(p->>'company', '(none)');
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'gl: own payment % needs what it applies to', v_id;
  END IF;
  SELECT coalesce(sum((x.v->>'amount')::numeric), 0) INTO v_sum FROM jsonb_array_elements(v_lines) AS x(v);
  IF v_sum IS DISTINCT FROM (p->>'amount')::numeric THEN
    RAISE EXCEPTION 'gl: what own payment % applies doesn''t add up to its amount', v_id;
  END IF;

  INSERT INTO public.gl_own_payments (
    netsuite_id, company_id, netsuite_number, made_from_id, customer_netsuite_id, customer_id, payment_date, method,
    reference, memo, deposited_to, amount, made_by
  ) VALUES (
    v_id, v_company, nullif(btrim(p->>'netsuite_number'), ''), nullif(p->>'made_from_id', '')::uuid,
    p->>'customer_netsuite_id', nullif(p->>'customer_id', '')::uuid, (p->>'payment_date')::date, p->>'method',
    nullif(btrim(coalesce(p->>'reference', '')), ''), nullif(btrim(coalesce(p->>'memo', '')), ''), p->>'deposited_to',
    (p->>'amount')::numeric, nullif(p->>'made_by', '')::uuid
  )
  ON CONFLICT (netsuite_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('saved', false, 'lines', 0);
  END IF;

  INSERT INTO public.gl_own_payment_applications (payment_id, line_no, invoice_netsuite_id, invoice_number, amount)
  SELECT v_id, x.line_no, x.invoice_netsuite_id, nullif(btrim(x.invoice_number), ''), x.amount
  FROM jsonb_to_recordset(v_lines) AS x(line_no INTEGER, invoice_netsuite_id TEXT, invoice_number TEXT, amount NUMERIC);

  RETURN jsonb_build_object('saved', true, 'lines', jsonb_array_length(v_lines));
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['received_payments', 'gl_own_payments', 'gl_own_payment_applications'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.received_payment_claim(jsonb)', 'public.received_payment_let_go(jsonb)',
                           'public.received_payment_made(jsonb)', 'public.gl_own_payment_save(jsonb)'] LOOP
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

COMMENT ON TABLE received_payments IS 'Migration 485: one row per press of Receive payment (src/lib/receive-payment.ts, /api/invoices/payment): the customer''s check or ACH payment, what it pays, who sent it, and the payment NetSuite made (its External ID is fleetsuite-cp- and this id) or why it didn''t. Moved only by its functions and the route''s note of an answer NetSuite didn''t give. Service-role write and read.';
COMMENT ON FUNCTION public.received_payment_claim(jsonb) IS 'Migration 485: takes the claim for a press of Receive payment, or says what became of the press before it. Service role only.';
COMMENT ON FUNCTION public.received_payment_let_go(jsonb) IS 'Migration 485: lets go of a press NetSuite didn''t make, keeping why, so the same form can be sent again. Service role only.';
COMMENT ON FUNCTION public.received_payment_made(jsonb) IS 'Migration 485: keeps the payment NetSuite made for a press. Service role only.';
COMMENT ON TABLE gl_own_payments IS 'Migration 485: Books'' own copy of each customer payment FleetSuite makes in NetSuite, saved only by gl_own_payment_save, by NetSuite''s id for the payment. Not checked against NetSuite''s or posted yet. Service-role write and read.';
COMMENT ON TABLE gl_own_payment_applications IS 'Migration 485: what each of Books'' own payments (gl_own_payments) pays: each invoice and how much of it. Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_payment_save(jsonb) IS 'Migration 485: saves Books'' own copy of a payment FleetSuite just made, refusing one whose invoices don''t add up to its amount; one already saved stays as it is. Service role only.';
