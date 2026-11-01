-- Migration 488: FleetSuite's own books, part 57 — vendors paid in
-- FleetSuite: payment runs asked for approval, approved by a super admin who
-- didn't ask, and made in NetSuite as one bill payment per vendor, switched
-- off.
--
-- Owner decisions (thread "Replacing NetSuite with FleetSuite"): receiving
-- and making payments, deposits and banking stay in NetSuite on January 1,
-- 2027 and move into FleetSuite during 2027, with FleetSuite sending each on
-- to NetSuite so nobody types anything twice (2026-10-31). The NetSuite Exit
-- Checklist's "Pay vendors" is payment runs with a second approver, checks
-- printed on BMG's stock, the First Bank ACH file and bank numbers kept
-- encrypted. This is its first slice: the run, its approval, and the bill
-- payments it makes in NetSuite (src/lib/pay-vendors.ts, /api/pay-vendors,
-- page /admin/pay-vendors, docs/books.md "Vendors paid in FleetSuite"). A
-- check is made To Be Printed in NetSuite, so until FleetSuite prints checks
-- they print from NetSuite's Print Checks as they do now.
--
--   * books_switches takes a fifteenth piece, vendor_payments, off. It stays
--     off past January 1, until paying vendors moves into FleetSuite;
--   * vendor_payment_runs, one row per payment run. Its id comes from the
--     page. It goes draft → waiting (asked for approval) → approved (its
--     payments being made) → done (each one made or dropped), and back to
--     draft when it's taken back or sent back with why. Only a draft changes,
--     an ask names the draft the asker saw, and an approval names the ask the
--     approver saw. While a run waits, or its payments are being made, the
--     bills in it are held: no other run with any of them is asked for;
--   * vendor_payment_run_payments, one row per vendor's payment in an
--     approved run, made from the run as it was asked when it's approved.
--     Its id is the bill payment's External ID in NetSuite ('fleetsuite-vp-'
--     and the id), so making it again never pays twice. It goes to_make →
--     sending → made, or to refused with NetSuite's reason (made again, or
--     dropped); one not made yet can be dropped, leaving its bills open;
--   * gl_own_bill_payments, Books' own copy of each bill payment FleetSuite
--     makes, written only by gl_own_bill_payment_save; saving the same
--     NetSuite payment again changes nothing. Checking the copies against
--     NetSuite's, and posting them, comes after.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 487 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all fifteen.
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
                   'customer_payments', 'customer_deposits', 'bank_deposits', 'vendor_payments'));

INSERT INTO books_switches (piece) VALUES ('vendor_payments') ON CONFLICT (piece) DO NOTHING;

-- ── The runs ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_payment_runs (
  -- Made by the page when the run is started.
  id UUID PRIMARY KEY,
  -- The company whose bills it pays, from one of its bank accounts.
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  -- The bank account it pays from, by NetSuite's id; a draft may have none yet.
  bank_account_netsuite_id TEXT CHECK (bank_account_netsuite_id ~ '^[0-9]+$'),
  bank_account_name TEXT CHECK (length(bank_account_name) <= 300),
  pay_date DATE NOT NULL,
  memo TEXT CHECK (length(memo) <= 300),
  -- Its payments as picked, one per vendor, each bill as NetSuite had it when it was picked:
  -- [{ vendor_netsuite_id, vendor_name, method ('check' or 'ach'),
  --    bills: [{ bill_netsuite_id, number, date, due_date, open_cents, cents }] }].
  payments JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(payments) = 'array' AND jsonb_array_length(payments) <= 50),
  -- NetSuite's ids for the bills it pays, for the hold on them.
  bill_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (cardinality(bill_ids) <= 500),
  -- What its payments come to.
  total_cents BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'waiting', 'approved', 'done')),
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who asked for approval, and when: an approval names this ask.
  asked_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  asked_at TIMESTAMPTZ,
  -- Sent back to be fixed, and why. Kept while it's fixed, until it's asked again.
  returned_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  returned_at TIMESTAMPTZ,
  returned_reason TEXT CHECK (length(returned_reason) <= 500),
  -- The approval that's making its payments, or made them.
  approved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  -- When the last of its payments was made or dropped.
  done_at TIMESTAMPTZ,
  CHECK (status = 'draft' OR asked_at IS NOT NULL),
  CHECK (status = 'draft' OR bank_account_netsuite_id IS NOT NULL),
  CHECK (status NOT IN ('approved', 'done') OR approved_at IS NOT NULL),
  CHECK ((status = 'done') = (done_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS vendor_payment_runs_status_idx ON vendor_payment_runs (status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS vendor_payment_runs_held_idx ON vendor_payment_runs USING gin (bill_ids) WHERE status IN ('waiting', 'approved');

CREATE TABLE IF NOT EXISTS vendor_payment_run_payments (
  -- The bill payment's External ID in NetSuite is 'fleetsuite-vp-' and this.
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES vendor_payment_runs(id) ON DELETE RESTRICT,
  -- Its place in the run, from 1.
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 50),
  vendor_netsuite_id TEXT NOT NULL CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT CHECK (length(vendor_name) <= 300),
  method TEXT NOT NULL CHECK (method IN ('check', 'ach')),
  -- The bills it pays, as the run was asked: [{ bill_netsuite_id, number, date, due_date, open_cents, cents }].
  bills JSONB NOT NULL CHECK (jsonb_typeof(bills) = 'array' AND jsonb_array_length(bills) BETWEEN 1 AND 100),
  bill_ids TEXT[] NOT NULL CHECK (cardinality(bill_ids) BETWEEN 1 AND 100),
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
  status TEXT NOT NULL DEFAULT 'to_make' CHECK (status IN ('to_make', 'sending', 'made', 'refused', 'dropped')),
  -- The press that's making it in NetSuite, or made it.
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  netsuite_payment_id TEXT CHECK (netsuite_payment_id ~ '^[0-9]+$'),
  netsuite_number TEXT,
  -- Why NetSuite didn't make it, or why FleetSuite can't tell, the last time it was sent.
  error TEXT CHECK (length(error) <= 2000),
  -- Dropped from the run, its bills left open, and why.
  dropped_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  dropped_at TIMESTAMPTZ,
  dropped_reason TEXT CHECK (length(dropped_reason) <= 500),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, position),
  UNIQUE (run_id, vendor_netsuite_id),
  CHECK ((status = 'made') = (netsuite_payment_id IS NOT NULL)),
  CHECK (status <> 'sending' OR sent_at IS NOT NULL),
  CHECK ((status = 'dropped') = (dropped_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS vendor_payment_run_payments_held_idx ON vendor_payment_run_payments USING gin (bill_ids)
  WHERE status IN ('to_make', 'sending', 'refused');

-- Saves a draft run, new or changed. p:
--   { id, company, bank_account_netsuite_id?, bank_account_name?, pay_date, memo?, by?,
--     payments: [{ vendor_netsuite_id, vendor_name?, method, bills: [{ bill_netsuite_id, number?, date?, due_date?,
--                  open_cents, cents }] }] }
-- Amounts are whole cents, $0 or more. Only a draft changes: a run asked for approval, approved or done stays as it is.
-- Returns { saved, status, updated_at }.
CREATE OR REPLACE FUNCTION public.vendor_payment_run_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_payments JSONB := coalesce(p->'payments', '[]'::jsonb);
  v_account TEXT := nullif(btrim(coalesce(p->>'bank_account_netsuite_id', '')), '');
  v_kept JSONB;
  v_ids TEXT[];
  v_total BIGINT;
  v_row public.vendor_payment_runs;
BEGIN
  IF jsonb_typeof(v_payments) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'vendor payments: a run''s payments must be a list';
  END IF;
  IF jsonb_array_length(v_payments) > 50 THEN
    RAISE EXCEPTION 'vendor payments: a run pays 50 vendors at most';
  END IF;
  IF v_account IS NOT NULL AND v_account !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'vendor payments: a run pays from a bank account, by NetSuite''s id for it';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payments) AS x(v)
    WHERE jsonb_typeof(x.v) IS DISTINCT FROM 'object'
       OR coalesce(x.v->>'vendor_netsuite_id', '') !~ '^[0-9]+$'
       OR coalesce(x.v->>'method', '') NOT IN ('check', 'ach')
       OR length(coalesce(x.v->>'vendor_name', '')) > 300
       OR jsonb_typeof(x.v->'bills') IS DISTINCT FROM 'array'
       OR jsonb_array_length(x.v->'bills') > 100
  ) THEN
    RAISE EXCEPTION 'vendor payments: each payment is a vendor (NetSuite''s id), check or ACH, and 100 bills at most';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payments) AS x(v), jsonb_array_elements(x.v->'bills') AS b(v)
    WHERE jsonb_typeof(b.v) IS DISTINCT FROM 'object'
       OR coalesce(b.v->>'bill_netsuite_id', '') !~ '^[0-9]+$'
       OR jsonb_typeof(b.v->'cents') IS DISTINCT FROM 'number'
       OR jsonb_typeof(b.v->'open_cents') IS DISTINCT FROM 'number'
       OR (b.v->>'cents')::numeric < 0 OR (b.v->>'open_cents')::numeric < 0
       OR (b.v->>'cents')::numeric <> trunc((b.v->>'cents')::numeric)
       OR (b.v->>'open_cents')::numeric <> trunc((b.v->>'open_cents')::numeric)
       OR (b.v->>'cents')::numeric > 1000000000 OR (b.v->>'open_cents')::numeric > 100000000000
       OR length(coalesce(b.v->>'number', '')) > 100
  ) THEN
    RAISE EXCEPTION 'vendor payments: each bill is NetSuite''s id for it and whole cents of $0 or more';
  END IF;

  -- Kept with only what a run keeps, each bill's days as days.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'vendor_netsuite_id', x.v->>'vendor_netsuite_id',
           'vendor_name', nullif(btrim(coalesce(x.v->>'vendor_name', '')), ''),
           'method', x.v->>'method',
           'bills', (
             SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'bill_netsuite_id', b.v->>'bill_netsuite_id',
                      'number', nullif(btrim(coalesce(b.v->>'number', '')), ''),
                      'date', CASE WHEN coalesce(b.v->>'date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN b.v->>'date' END,
                      'due_date', CASE WHEN coalesce(b.v->>'due_date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN b.v->>'due_date' END,
                      'open_cents', (b.v->>'open_cents')::bigint,
                      'cents', (b.v->>'cents')::bigint
                    ) ORDER BY b.n), '[]'::jsonb)
             FROM jsonb_array_elements(x.v->'bills') WITH ORDINALITY AS b(v, n)
           )
         ) ORDER BY x.n), '[]'::jsonb)
  INTO v_kept
  FROM jsonb_array_elements(v_payments) WITH ORDINALITY AS x(v, n);

  SELECT coalesce(array_agg(b.v->>'bill_netsuite_id' ORDER BY x.n, b.n), ARRAY[]::TEXT[]), coalesce(sum((b.v->>'cents')::bigint), 0)
  INTO v_ids, v_total
  FROM jsonb_array_elements(v_kept) WITH ORDINALITY AS x(v, n), jsonb_array_elements(x.v->'bills') WITH ORDINALITY AS b(v, n);
  IF cardinality(v_ids) > 500 THEN
    RAISE EXCEPTION 'vendor payments: a run pays 500 bills at most';
  END IF;

  INSERT INTO public.vendor_payment_runs (
    id, company, bank_account_netsuite_id, bank_account_name, pay_date, memo, payments, bill_ids, total_cents, created_by, updated_by
  ) VALUES (
    v_id, btrim(p->>'company'), v_account, nullif(btrim(coalesce(p->>'bank_account_name', '')), ''), (p->>'pay_date')::date,
    nullif(btrim(coalesce(p->>'memo', '')), ''), v_kept, v_ids, v_total, nullif(p->>'by', '')::uuid, nullif(p->>'by', '')::uuid
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('saved', true, 'status', v_row.status, 'updated_at', v_row.updated_at);
  END IF;

  SELECT * INTO v_row FROM public.vendor_payment_runs WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Deleted between the two.
    RETURN jsonb_build_object('saved', false, 'status', 'gone');
  END IF;
  IF v_row.status <> 'draft' THEN
    RETURN jsonb_build_object('saved', false, 'status', v_row.status, 'updated_at', v_row.updated_at);
  END IF;
  UPDATE public.vendor_payment_runs
  SET company = btrim(p->>'company'), bank_account_netsuite_id = v_account,
      bank_account_name = nullif(btrim(coalesce(p->>'bank_account_name', '')), ''), pay_date = (p->>'pay_date')::date,
      memo = nullif(btrim(coalesce(p->>'memo', '')), ''), payments = v_kept, bill_ids = v_ids, total_cents = v_total,
      updated_by = nullif(p->>'by', '')::uuid, updated_at = now()
  WHERE id = v_id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('saved', true, 'status', v_row.status, 'updated_at', v_row.updated_at);
END;
$$;

-- The bills of these that another run holds: one asked for approval, or approved with a payment of them not made or
-- dropped yet. Every other run but `except`.
CREATE OR REPLACE FUNCTION public.vendor_payment_bills_held(p_ids TEXT[], p_except UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(DISTINCT h.id ORDER BY h.id), ARRAY[]::TEXT[])
  FROM (
    SELECT held.id
    FROM public.vendor_payment_runs r, unnest(r.bill_ids) AS held(id)
    WHERE r.status = 'waiting' AND r.id IS DISTINCT FROM p_except AND r.bill_ids && p_ids AND held.id = ANY (p_ids)
    UNION
    SELECT held.id
    FROM public.vendor_payment_run_payments pay, unnest(pay.bill_ids) AS held(id)
    WHERE pay.status IN ('to_make', 'sending', 'refused') AND pay.run_id IS DISTINCT FROM p_except
      AND pay.bill_ids && p_ids AND held.id = ANY (p_ids)
  ) AS h;
$$;

-- Asks for approval of a draft run. p: { id, by?, updated_at } — updated_at is the draft as the asker saw it.
-- The draft must be whole: a bank account, a vendor once each with a bill or more, a bill once, each paying more than
-- $0 and no more than it had open when it was picked (the route checks it against NetSuite first;
-- src/lib/pay-vendors.ts), and none of its bills held by another run.
-- Answers { state }: 'asked' (asked_at), 'changed' (it was saved again since), 'held' (held: the bills another run
-- holds), 'gone', or where it is now.
CREATE OR REPLACE FUNCTION public.vendor_payment_run_ask(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_payment_runs;
  v_payments INTEGER;
  v_empty INTEGER;
  v_vendors INTEGER;
  v_good INTEGER;
  v_distinct INTEGER;
  v_held TEXT[];
BEGIN
  -- One ask or approval at a time, so two runs never hold the same bill.
  LOCK TABLE public.vendor_payment_runs IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_row FROM public.vendor_payment_runs WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'draft' THEN
    RETURN jsonb_build_object('state', v_row.status);
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'updated_at')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;

  SELECT count(*), count(*) FILTER (WHERE jsonb_array_length(x.v->'bills') = 0), count(DISTINCT x.v->>'vendor_netsuite_id')
  INTO v_payments, v_empty, v_vendors
  FROM jsonb_array_elements(v_row.payments) AS x(v);
  SELECT count(*) FILTER (WHERE (b.v->>'cents')::bigint > 0 AND (b.v->>'cents')::bigint <= (b.v->>'open_cents')::bigint),
         count(DISTINCT b.v->>'bill_netsuite_id')
  INTO v_good, v_distinct
  FROM jsonb_array_elements(v_row.payments) AS x(v), jsonb_array_elements(x.v->'bills') AS b(v);
  IF v_row.bank_account_netsuite_id IS NULL OR v_payments < 1 OR v_empty > 0 OR v_vendors <> v_payments
     OR v_good <> cardinality(v_row.bill_ids) OR v_distinct <> cardinality(v_row.bill_ids) THEN
    RAISE EXCEPTION 'vendor payments: run % needs a bank account and a vendor once each, each paying a bill or more, a bill once, each more than $0 and no more than it had open', v_row.id;
  END IF;

  v_held := public.vendor_payment_bills_held(v_row.bill_ids, v_row.id);
  IF cardinality(v_held) > 0 THEN
    RETURN jsonb_build_object('state', 'held', 'held', to_jsonb(v_held));
  END IF;

  UPDATE public.vendor_payment_runs
  SET status = 'waiting', asked_by = nullif(p->>'by', '')::uuid, asked_at = now(),
      returned_by = NULL, returned_at = NULL, returned_reason = NULL
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'asked', 'asked_at', v_row.asked_at);
END;
$$;

-- Takes a run asked for approval back to a draft, to change it. p: { id, by? }.
-- Answers { state }: 'taken_back', or where it is when it isn't waiting ('gone' when there's no such run).
CREATE OR REPLACE FUNCTION public.vendor_payment_run_take_back(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_payment_runs;
BEGIN
  SELECT * INTO v_row FROM public.vendor_payment_runs WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'waiting' THEN
    RETURN jsonb_build_object('state', v_row.status);
  END IF;
  UPDATE public.vendor_payment_runs
  SET status = 'draft', asked_by = NULL, asked_at = NULL, updated_by = nullif(p->>'by', '')::uuid, updated_at = now()
  WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'taken_back');
END;
$$;

-- Sends a run asked for approval back to be fixed, with why. p: { id, by?, reason }.
-- Answers { state }: 'sent_back', or where it is when it isn't waiting ('gone' when there's no such run).
CREATE OR REPLACE FUNCTION public.vendor_payment_run_send_back(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_payment_runs;
  v_reason TEXT := nullif(btrim(coalesce(p->>'reason', '')), '');
BEGIN
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'vendor payments: sending a run back needs a reason';
  END IF;
  SELECT * INTO v_row FROM public.vendor_payment_runs WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'waiting' THEN
    RETURN jsonb_build_object('state', v_row.status);
  END IF;
  UPDATE public.vendor_payment_runs
  SET status = 'draft', asked_by = NULL, asked_at = NULL, returned_by = nullif(p->>'by', '')::uuid, returned_at = now(),
      returned_reason = left(v_reason, 500), updated_at = now()
  WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'sent_back');
END;
$$;

-- Approves a run asked for approval, by someone who didn't ask. p: { id, approver, asked_at } — asked_at is the ask
-- as the approver saw it. Makes one payment row per vendor from the run as it was asked, each to be made.
-- Answers { state } with:
--   'claimed'   this approval approved it (run);
--   'approved'  it's approved already, its payments being made (run);
--   'done'      each of its payments is made or dropped already;
--   'changed'   it was taken back or asked again since the approver looked;
--   'yours'     the approver is the one who asked;
--   'draft' or 'gone'.
CREATE OR REPLACE FUNCTION public.vendor_payment_run_approve(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_payment_runs;
BEGIN
  IF nullif(p->>'approver', '') IS NULL THEN
    RAISE EXCEPTION 'vendor payments: an approval needs who approved it';
  END IF;
  LOCK TABLE public.vendor_payment_runs IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_row FROM public.vendor_payment_runs WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status IN ('approved', 'done') THEN
    RETURN jsonb_build_object('state', v_row.status, 'run', to_jsonb(v_row));
  END IF;
  IF v_row.status = 'draft' THEN
    RETURN jsonb_build_object('state', 'draft');
  END IF;
  IF v_row.asked_at IS DISTINCT FROM (p->>'asked_at')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;
  IF v_row.asked_by = (p->>'approver')::uuid THEN
    RETURN jsonb_build_object('state', 'yours');
  END IF;

  UPDATE public.vendor_payment_runs
  SET status = 'approved', approved_by = (p->>'approver')::uuid, approved_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  INSERT INTO public.vendor_payment_run_payments (run_id, position, vendor_netsuite_id, vendor_name, method, bills, bill_ids, total_cents)
  SELECT v_row.id, x.n, x.v->>'vendor_netsuite_id', x.v->>'vendor_name', x.v->>'method', x.v->'bills',
         (SELECT array_agg(b.v->>'bill_netsuite_id' ORDER BY b.n) FROM jsonb_array_elements(x.v->'bills') WITH ORDINALITY AS b(v, n)),
         (SELECT sum((b.v->>'cents')::bigint) FROM jsonb_array_elements(x.v->'bills') AS b(v))
  FROM jsonb_array_elements(v_row.payments) WITH ORDINALITY AS x(v, n);

  RETURN jsonb_build_object('state', 'claimed', 'run', to_jsonb(v_row));
END;
$$;

-- The run is done once none of its payments is left to make: each one made or dropped. p_run: the run.
CREATE OR REPLACE FUNCTION public.vendor_payment_run_finish(p_run UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.vendor_payment_runs
  SET status = 'done', done_at = now()
  WHERE id = p_run AND status = 'approved'
    AND NOT EXISTS (
      SELECT 1 FROM public.vendor_payment_run_payments pay WHERE pay.run_id = p_run AND pay.status IN ('to_make', 'sending', 'refused')
    );
  RETURN FOUND;
END;
$$;

-- Takes the claim for making one of an approved run's payments. p: { id, by }.
-- Answers { state } with:
--   'made'     it's in NetSuite already (netsuite_payment_id, netsuite_number);
--   'sending'  a press holds it and is making it, or NetSuite hasn't said whether it did (payment);
--   'dropped'  it was dropped from the run;
--   'claimed'  this press now holds it (payment);
--   'gone'.
-- A press NetSuite refused lets go of it (vendor_payment_let_go), and it can be made again.
CREATE OR REPLACE FUNCTION public.vendor_payment_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_payment_run_payments;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'vendor payments: making a payment needs who made it';
  END IF;
  SELECT * INTO v_row FROM public.vendor_payment_run_payments WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status = 'made' THEN
    RETURN jsonb_build_object('state', 'made', 'netsuite_payment_id', v_row.netsuite_payment_id, 'netsuite_number', v_row.netsuite_number);
  END IF;
  IF v_row.status = 'sending' THEN
    RETURN jsonb_build_object('state', 'sending', 'payment', to_jsonb(v_row));
  END IF;
  IF v_row.status = 'dropped' THEN
    RETURN jsonb_build_object('state', 'dropped');
  END IF;
  UPDATE public.vendor_payment_run_payments
  SET status = 'sending', sent_by = (p->>'by')::uuid, sent_at = now(), error = NULL, updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'claimed', 'payment', to_jsonb(v_row));
END;
$$;

-- Lets go of a press that didn't make the payment, keeping why: it's refused, to make again or drop.
-- p: { id, error }. Returns { let_go }.
CREATE OR REPLACE FUNCTION public.vendor_payment_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.vendor_payment_run_payments
  SET status = 'refused', error = left(coalesce(nullif(btrim(p->>'error'), ''), 'Not made'), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('let_go', FOUND);
END;
$$;

-- Keeps the bill payment NetSuite made for a press. p: { id, netsuite_payment_id, netsuite_number? }.
-- Returns { made, run_done } — made is false when it isn't being made (made already, or let go); run_done when it
-- was the run's last payment to make.
CREATE OR REPLACE FUNCTION public.vendor_payment_made(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_run UUID;
BEGIN
  IF coalesce(p->>'netsuite_payment_id', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'vendor payments: a made payment needs NetSuite''s id for its bill payment';
  END IF;
  UPDATE public.vendor_payment_run_payments
  SET status = 'made', netsuite_payment_id = p->>'netsuite_payment_id', netsuite_number = nullif(btrim(p->>'netsuite_number'), ''),
      error = NULL, updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending'
  RETURNING run_id INTO v_run;
  IF v_run IS NULL THEN
    RETURN jsonb_build_object('made', false, 'run_done', false);
  END IF;
  RETURN jsonb_build_object('made', true, 'run_done', public.vendor_payment_run_finish(v_run));
END;
$$;

-- Drops a payment not made yet from its run, leaving its bills open in NetSuite. p: { id, by, reason? }.
-- Answers { state, run_done }: 'dropped', or why it can't be: 'sending', 'made', 'already_dropped' or 'gone'.
CREATE OR REPLACE FUNCTION public.vendor_payment_drop(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_payment_run_payments;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'vendor payments: dropping a payment needs who dropped it';
  END IF;
  SELECT * INTO v_row FROM public.vendor_payment_run_payments WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone', 'run_done', false);
  END IF;
  -- Being made, made, or dropped already: nothing changes, and it says which.
  IF v_row.status NOT IN ('to_make', 'refused') THEN
    RETURN jsonb_build_object('state', CASE v_row.status WHEN 'dropped' THEN 'already_dropped' ELSE v_row.status END, 'run_done', false);
  END IF;
  UPDATE public.vendor_payment_run_payments
  SET status = 'dropped', dropped_by = (p->>'by')::uuid, dropped_at = now(),
      dropped_reason = left(nullif(btrim(coalesce(p->>'reason', '')), ''), 500), updated_at = now()
  WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'dropped', 'run_done', public.vendor_payment_run_finish(v_row.run_id));
END;
$$;

-- ── Books' own copy ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_bill_payments (
  -- NetSuite's internal id for the bill payment FleetSuite made.
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_number TEXT,
  -- The run and its payment that made it (vendor_payment_runs, vendor_payment_run_payments).
  made_from_run UUID,
  made_from_payment UUID,
  vendor_netsuite_id TEXT NOT NULL CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT,
  -- The bank account it was paid from.
  bank_account_netsuite_id TEXT NOT NULL CHECK (bank_account_netsuite_id ~ '^[0-9]+$'),
  payment_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('check', 'ach')),
  memo TEXT,
  -- The bills it paid: [{ netsuite_id, number, amount }].
  bills JSONB NOT NULL CHECK (jsonb_typeof(bills) = 'array' AND jsonb_array_length(bills) > 0),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  asked_by UUID,
  approved_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_own_bill_payments_date ON gl_own_bill_payments(payment_date DESC, netsuite_id);

-- Saves Books' own copy of a bill payment FleetSuite just made. p:
--   { netsuite_id, netsuite_number?, company ('BMG' or '1084'), made_from_run?, made_from_payment?, vendor_netsuite_id,
--     vendor_name?, bank_account_netsuite_id, payment_date, method, memo?, bills, amount, asked_by?, approved_by? }
-- A copy of that payment already saved stays as it is. Returns { saved }.
CREATE OR REPLACE FUNCTION public.gl_own_bill_payment_save(p JSONB)
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
    RAISE EXCEPTION 'gl: an own bill payment needs NetSuite''s id for it';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = p->>'company';
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(p->>'company', '(none)');
  END IF;

  INSERT INTO public.gl_own_bill_payments (
    netsuite_id, company_id, netsuite_number, made_from_run, made_from_payment, vendor_netsuite_id, vendor_name,
    bank_account_netsuite_id, payment_date, method, memo, bills, amount, asked_by, approved_by
  ) VALUES (
    v_id, v_company, nullif(btrim(p->>'netsuite_number'), ''), nullif(p->>'made_from_run', '')::uuid,
    nullif(p->>'made_from_payment', '')::uuid, p->>'vendor_netsuite_id', nullif(btrim(coalesce(p->>'vendor_name', '')), ''),
    p->>'bank_account_netsuite_id', (p->>'payment_date')::date, p->>'method', nullif(btrim(coalesce(p->>'memo', '')), ''),
    p->'bills', (p->>'amount')::numeric, nullif(p->>'asked_by', '')::uuid, nullif(p->>'approved_by', '')::uuid
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
  FOREACH t IN ARRAY ARRAY['vendor_payment_runs', 'vendor_payment_run_payments', 'gl_own_bill_payments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.vendor_payment_run_save(jsonb)', 'public.vendor_payment_bills_held(text[], uuid)',
                           'public.vendor_payment_run_ask(jsonb)', 'public.vendor_payment_run_take_back(jsonb)',
                           'public.vendor_payment_run_send_back(jsonb)', 'public.vendor_payment_run_approve(jsonb)',
                           'public.vendor_payment_run_finish(uuid)', 'public.vendor_payment_claim(jsonb)',
                           'public.vendor_payment_let_go(jsonb)', 'public.vendor_payment_made(jsonb)',
                           'public.vendor_payment_drop(jsonb)', 'public.gl_own_bill_payment_save(jsonb)'] LOOP
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

COMMENT ON TABLE vendor_payment_runs IS 'Migration 488: one row per payment run on the Pay vendors page (src/lib/pay-vendors.ts, /api/pay-vendors): the company''s bills it pays, vendor by vendor, by check or ACH from one bank account on one day, who asked for approval, who sent it back and why, and who approved it. Moved only by its functions. Service-role write and read.';
COMMENT ON TABLE vendor_payment_run_payments IS 'Migration 488: one row per vendor''s payment in an approved run, made from the run as it was asked: the bills it pays and the bill payment NetSuite made (its External ID is fleetsuite-vp- and this id), why it didn''t, or that it was dropped. Moved only by its functions and the route''s note of an answer NetSuite didn''t give. Service-role write and read.';
COMMENT ON FUNCTION public.vendor_payment_run_save(jsonb) IS 'Migration 488: saves a draft payment run, new or changed; a run asked for approval, approved or done stays as it is. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_bills_held(text[], uuid) IS 'Migration 488: which of these bills another payment run holds, asked for approval or with a payment of them not made or dropped yet. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_run_ask(jsonb) IS 'Migration 488: asks for approval of a whole draft payment run, as the asker saw it, none of its bills held by another run. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_run_take_back(jsonb) IS 'Migration 488: takes a payment run asked for approval back to a draft. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_run_send_back(jsonb) IS 'Migration 488: sends a payment run asked for approval back to be fixed, with why. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_run_approve(jsonb) IS 'Migration 488: approves the ask the approver saw, by someone who didn''t ask, making a payment to be made for each vendor, or says what became of it. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_run_finish(uuid) IS 'Migration 488: marks an approved payment run done once each of its payments is made or dropped. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_claim(jsonb) IS 'Migration 488: takes the claim for making one of an approved run''s payments, or says what became of it. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_let_go(jsonb) IS 'Migration 488: lets go of a press NetSuite didn''t make, keeping why; the payment can be made again or dropped. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_made(jsonb) IS 'Migration 488: keeps the bill payment NetSuite made for a press, and marks the run done after its last. Service role only.';
COMMENT ON FUNCTION public.vendor_payment_drop(jsonb) IS 'Migration 488: drops a payment not made yet from its run, leaving its bills open. Service role only.';
COMMENT ON TABLE gl_own_bill_payments IS 'Migration 488: Books'' own copy of each bill payment FleetSuite makes in NetSuite, saved only by gl_own_bill_payment_save, by NetSuite''s id for it. Not checked against NetSuite''s or posted yet. Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_bill_payment_save(jsonb) IS 'Migration 488: saves Books'' own copy of a bill payment FleetSuite just made; one already saved stays as it is. Service role only.';
