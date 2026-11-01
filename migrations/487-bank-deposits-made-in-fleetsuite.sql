-- Migration 487: FleetSuite's own books, part 56 — bank deposits made in
-- FleetSuite: customer payments and deposits waiting in Undeposited Funds,
-- deposited to one of the company's bank accounts and sent on to NetSuite,
-- switched off.
--
-- Owner decisions (thread "Replacing NetSuite with FleetSuite"): receiving
-- and making payments, deposits and banking stay in NetSuite on January 1,
-- 2027 and move into FleetSuite during 2027, each before its move, with
-- FleetSuite sending each on to NetSuite so nobody types anything twice
-- (2026-10-31). After payments on invoices (part 54) and deposits on orders
-- (part 55), both made in Undeposited Funds, comes the bank deposit that
-- moves them to the bank. Invoicing → Invoiced's Bank deposit lists what
-- NetSuite has waiting in Undeposited Funds for a company, as NetSuite's Make
-- Deposits does; the payments and deposits ticked go into the bank account
-- picked, as one bank deposit in NetSuite, once (src/lib/bank-deposit.ts,
-- /api/invoices/bank-deposit, page /invoices/bank-deposit, docs/books.md
-- "Bank deposits made in FleetSuite").
--
--   * books_switches takes a fourteenth piece, bank_deposits, off. It stays
--     off past January 1, until bank deposits move into FleetSuite;
--   * made_bank_deposits, one row per press of Make deposit. Its id comes
--     from the page and is the bank deposit's External ID in NetSuite
--     ('fleetsuite-bd-' and the id), so pressing it again never makes a
--     second one. It goes sending (being made in NetSuite) → made, or back to
--     open with NetSuite's reason when NetSuite doesn't make it, so the same
--     form can be sent again. While it's being made, the payments and
--     deposits in it are held: another press with any of them is turned away
--     until this one is made or let go;
--   * gl_own_bank_deposits, Books' own copy of each bank deposit FleetSuite
--     makes, written only by gl_own_bank_deposit_save; saving the same
--     NetSuite deposit again changes nothing. Checking the copies against
--     NetSuite's, and posting them, comes after.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 486 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all fourteen.
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
                   'customer_payments', 'customer_deposits', 'bank_deposits'));

INSERT INTO books_switches (piece) VALUES ('bank_deposits') ON CONFLICT (piece) DO NOTHING;

-- ── Each press of Make deposit ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS made_bank_deposits (
  -- Made by the page when it opens; its External ID in NetSuite is 'fleetsuite-bd-' and this.
  id UUID PRIMARY KEY,
  -- The company whose bank account it goes into.
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  subsidiary_netsuite_id TEXT NOT NULL CHECK (subsidiary_netsuite_id ~ '^[0-9]+$'),
  bank_account_netsuite_id TEXT NOT NULL CHECK (bank_account_netsuite_id ~ '^[0-9]+$'),
  bank_account_name TEXT CHECK (length(bank_account_name) <= 300),
  deposit_date DATE NOT NULL,
  memo TEXT CHECK (length(memo) <= 300),
  -- The payments and deposits in it, as NetSuite had them waiting:
  -- [{ netsuite_id, kind ('payment' or 'deposit'), number, date, customer_name, reference, cents }].
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 100),
  -- NetSuite's ids for them, for the hold on them while this press is being made.
  line_ids TEXT[] NOT NULL CHECK (cardinality(line_ids) BETWEEN 1 AND 100),
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
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
  CHECK (status <> 'sending' OR sent_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS made_bank_deposits_company_idx ON made_bank_deposits (company, created_at DESC, id);
CREATE INDEX IF NOT EXISTS made_bank_deposits_sending_idx ON made_bank_deposits USING gin (line_ids) WHERE status = 'sending';

-- Takes the claim for a press of Make deposit. p:
--   { id, by, company, subsidiary_netsuite_id, bank_account_netsuite_id, bank_account_name?, deposit_date, memo?,
--     lines: [{ netsuite_id, kind, number, date, customer_name, reference?, cents }] }
-- The route works the bank deposit out from what NetSuite has waiting first (src/lib/bank-deposit.ts).
-- Answers { state } with:
--   'made'     it's in NetSuite already (netsuite_deposit_id, netsuite_number);
--   'sending'  a press holds it and is making it, or NetSuite hasn't said whether it did (deposit);
--   'held'     another press being made now has some of its payments or deposits (held: their NetSuite ids);
--   'claimed'  this press now holds it, as sent now (deposit).
-- A press NetSuite refused lets go of it (made_bank_deposit_let_go), and the same form can be sent again.
CREATE OR REPLACE FUNCTION public.made_bank_deposit_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_lines JSONB := p->'lines';
  v_line JSONB;
  v_ids TEXT[] := ARRAY[]::TEXT[];
  v_total BIGINT := 0;
  v_held TEXT[];
  v_exists BOOLEAN;
  v_row public.made_bank_deposits;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'bank deposits: a send needs who sent it';
  END IF;
  IF coalesce(p->>'bank_account_netsuite_id', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'bank deposits: a bank deposit goes into a bank account, by NetSuite''s id for it';
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(v_lines) < 1 OR jsonb_array_length(v_lines) > 100 THEN
    RAISE EXCEPTION 'bank deposits: a bank deposit has 1 to 100 payments and deposits in it';
  END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_lines) LOOP
    IF coalesce(v_line->>'netsuite_id', '') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'bank deposits: each payment or deposit in it is by NetSuite''s id for it';
    END IF;
    IF (v_line->>'netsuite_id') = ANY (v_ids) THEN
      RAISE EXCEPTION 'bank deposits: payment % is in it twice', v_line->>'netsuite_id';
    END IF;
    IF jsonb_typeof(v_line->'cents') IS DISTINCT FROM 'number' OR (v_line->>'cents')::numeric <> round((v_line->>'cents')::numeric)
       OR (v_line->>'cents')::numeric <= 0 THEN
      RAISE EXCEPTION 'bank deposits: each payment or deposit in it is a whole number of cents above 0';
    END IF;
    v_ids := v_ids || (v_line->>'netsuite_id');
    v_total := v_total + (v_line->>'cents')::bigint;
  END LOOP;

  -- One claim at a time, so two presses never hold the same payment.
  LOCK TABLE public.made_bank_deposits IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_row FROM public.made_bank_deposits WHERE id = v_id FOR UPDATE;
  v_exists := FOUND;
  IF v_exists AND v_row.status = 'made' THEN
    RETURN jsonb_build_object('state', 'made', 'netsuite_deposit_id', v_row.netsuite_deposit_id, 'netsuite_number', v_row.netsuite_number);
  END IF;
  IF v_exists AND v_row.status = 'sending' THEN
    RETURN jsonb_build_object('state', 'sending', 'deposit', to_jsonb(v_row));
  END IF;

  SELECT coalesce(array_agg(DISTINCT held.id ORDER BY held.id), ARRAY[]::TEXT[]) INTO v_held
  FROM public.made_bank_deposits d, unnest(d.line_ids) AS held(id)
  WHERE d.status = 'sending' AND d.id <> v_id AND d.line_ids && v_ids AND held.id = ANY (v_ids);
  IF cardinality(v_held) > 0 THEN
    RETURN jsonb_build_object('state', 'held', 'held', to_jsonb(v_held));
  END IF;

  IF NOT v_exists THEN
    INSERT INTO public.made_bank_deposits (
      id, company, subsidiary_netsuite_id, bank_account_netsuite_id, bank_account_name, deposit_date, memo, lines, line_ids,
      total_cents, status, sent_by, sent_at, created_by
    ) VALUES (
      v_id, btrim(p->>'company'), p->>'subsidiary_netsuite_id', p->>'bank_account_netsuite_id',
      nullif(btrim(coalesce(p->>'bank_account_name', '')), ''), (p->>'deposit_date')::date, nullif(btrim(coalesce(p->>'memo', '')), ''),
      v_lines, v_ids, v_total, 'sending', (p->>'by')::uuid, now(), (p->>'by')::uuid
    )
    RETURNING * INTO v_row;
    RETURN jsonb_build_object('state', 'claimed', 'deposit', to_jsonb(v_row));
  END IF;

  -- Let go after NetSuite refused it: sent again, as it's sent now.
  UPDATE public.made_bank_deposits
  SET company = btrim(p->>'company'), subsidiary_netsuite_id = p->>'subsidiary_netsuite_id',
      bank_account_netsuite_id = p->>'bank_account_netsuite_id',
      bank_account_name = nullif(btrim(coalesce(p->>'bank_account_name', '')), ''), deposit_date = (p->>'deposit_date')::date,
      memo = nullif(btrim(coalesce(p->>'memo', '')), ''), lines = v_lines, line_ids = v_ids, total_cents = v_total,
      status = 'sending', sent_by = (p->>'by')::uuid, sent_at = now(), error = NULL, updated_at = now()
  WHERE id = v_id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'claimed', 'deposit', to_jsonb(v_row));
END;
$$;

-- Lets go of a press that didn't make the bank deposit, keeping why, so the same form can be sent again and the
-- payments in it are free. p: { id, error }. Returns { let_go }.
CREATE OR REPLACE FUNCTION public.made_bank_deposit_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.made_bank_deposits
  SET status = 'open', sent_by = NULL, sent_at = NULL,
      error = left(coalesce(nullif(btrim(p->>'error'), ''), 'Not made'), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('let_go', FOUND);
END;
$$;

-- Keeps the bank deposit NetSuite made for a press. p: { id, netsuite_deposit_id, netsuite_number? }.
-- Returns { made } — false when it isn't being made (made already, or let go).
CREATE OR REPLACE FUNCTION public.made_bank_deposit_made(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(p->>'netsuite_deposit_id', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'bank deposits: a made bank deposit needs NetSuite''s id for it';
  END IF;
  UPDATE public.made_bank_deposits
  SET status = 'made', netsuite_deposit_id = p->>'netsuite_deposit_id', netsuite_number = nullif(btrim(p->>'netsuite_number'), ''),
      error = NULL, updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('made', FOUND);
END;
$$;

-- ── Books' own copy ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_bank_deposits (
  -- NetSuite's internal id for the bank deposit FleetSuite made.
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_number TEXT,
  -- The press of Make deposit that made it (made_bank_deposits).
  made_from_id UUID,
  -- The bank account it went into.
  bank_account_netsuite_id TEXT NOT NULL CHECK (bank_account_netsuite_id ~ '^[0-9]+$'),
  deposit_date DATE NOT NULL,
  memo TEXT,
  -- The payments and deposits it moved out of Undeposited Funds: [{ netsuite_id, kind, number, customer_name, amount }].
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_own_bank_deposits_date ON gl_own_bank_deposits(deposit_date DESC, netsuite_id);

-- Saves Books' own copy of a bank deposit FleetSuite just made. p:
--   { netsuite_id, netsuite_number?, company ('BMG' or '1084'), made_from_id?, bank_account_netsuite_id, deposit_date,
--     memo?, lines, amount, made_by? }
-- A copy of that deposit already saved stays as it is. Returns { saved }.
CREATE OR REPLACE FUNCTION public.gl_own_bank_deposit_save(p JSONB)
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
    RAISE EXCEPTION 'gl: an own bank deposit needs NetSuite''s id for it';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = p->>'company';
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(p->>'company', '(none)');
  END IF;

  INSERT INTO public.gl_own_bank_deposits (
    netsuite_id, company_id, netsuite_number, made_from_id, bank_account_netsuite_id, deposit_date, memo, lines, amount, made_by
  ) VALUES (
    v_id, v_company, nullif(btrim(p->>'netsuite_number'), ''), nullif(p->>'made_from_id', '')::uuid,
    p->>'bank_account_netsuite_id', (p->>'deposit_date')::date, nullif(btrim(coalesce(p->>'memo', '')), ''), p->'lines',
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
  FOREACH t IN ARRAY ARRAY['made_bank_deposits', 'gl_own_bank_deposits'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.made_bank_deposit_claim(jsonb)', 'public.made_bank_deposit_let_go(jsonb)',
                           'public.made_bank_deposit_made(jsonb)', 'public.gl_own_bank_deposit_save(jsonb)'] LOOP
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

COMMENT ON TABLE made_bank_deposits IS 'Migration 487: one row per press of Make deposit (src/lib/bank-deposit.ts, /api/invoices/bank-deposit): the payments and deposits waiting in Undeposited Funds it moves into a bank account, who sent it, and the bank deposit NetSuite made (its External ID is fleetsuite-bd- and this id) or why it didn''t. Moved only by its functions and the route''s note of an answer NetSuite didn''t give. Service-role write and read.';
COMMENT ON FUNCTION public.made_bank_deposit_claim(jsonb) IS 'Migration 487: takes the claim for a press of Make deposit, or says what became of the press before it, or which of its payments another press being made holds. Service role only.';
COMMENT ON FUNCTION public.made_bank_deposit_let_go(jsonb) IS 'Migration 487: lets go of a press NetSuite didn''t make, keeping why, so the same form can be sent again. Service role only.';
COMMENT ON FUNCTION public.made_bank_deposit_made(jsonb) IS 'Migration 487: keeps the bank deposit NetSuite made for a press. Service role only.';
COMMENT ON TABLE gl_own_bank_deposits IS 'Migration 487: Books'' own copy of each bank deposit FleetSuite makes in NetSuite, saved only by gl_own_bank_deposit_save, by NetSuite''s id for it. Not checked against NetSuite''s or posted yet. Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_bank_deposit_save(jsonb) IS 'Migration 487: saves Books'' own copy of a bank deposit FleetSuite just made; one already saved stays as it is. Service role only.';
