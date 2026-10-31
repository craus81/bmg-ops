-- Migration 468: FleetSuite's own books, part 36 — Chase card charges coded
-- in FleetSuite and sent to NetSuite as journal entries, switched off until
-- January 1, 2027.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking; each piece that takes
-- them out of NetSuite is built switched off, and FleetSuite sends its
-- document on to NetSuite. Card charges come third. The bookkeeper enters the
-- Chase card's statements in NetSuite as journal entries (owner, 2026-10-16),
-- so FleetSuite does the same: the card's activity downloaded from Chase,
-- each charge coded to its account (FleetSuite remembers each merchant's
-- account), and each month's charges sent as one journal entry, two lines a
-- charge (src/lib/card-charges.ts, /api/card-charges, page /admin/card-charges,
-- docs/books.md "Card charges coded in FleetSuite").
--
--   * books_switches takes a third piece, card_charges, off;
--   * card_charge_imports, one row per file added; card_charges, one row per
--     charge, kept once per card however often a download repeats it (its
--     fingerprint); card_merchant_rules, the account each merchant's charges
--     last went to, per company;
--   * card_charge_sends, one row per press of Send: its id comes from the
--     page and is the journal entry's External ID in NetSuite, so a send
--     tried again never makes a second one. A send claims its charges; a
--     refused one lets go of them and keeps NetSuite's reason;
--   * gl_own_journal_entries and gl_own_journal_entry_lines, Books' own copy
--     of each journal entry FleetSuite makes, written only by
--     gl_own_journal_entry_save, which keeps each one whole: its debits match
--     its credits and its total, and saving the same NetSuite journal entry
--     again changes nothing. Checking the copies against NetSuite's comes
--     after.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 467 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all three.
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
  CHECK (piece IN ('credit_memos', 'vendor_credits', 'card_charges'));

INSERT INTO books_switches (piece) VALUES ('card_charges') ON CONFLICT (piece) DO NOTHING;

-- ── Files added ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_charge_imports (
  -- Made by the page: the same file added twice in one go is one import.
  id UUID PRIMARY KEY,
  -- gl_companies.code: whose books the card is in.
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  -- The card's own account in NetSuite's chart.
  card_account_netsuite_id TEXT NOT NULL CHECK (card_account_netsuite_id ~ '^[0-9]+$'),
  file_name TEXT,
  -- The charges in the file, how many were new, how many were here already,
  -- and how many came in coded to the merchant's remembered account.
  charges INTEGER NOT NULL DEFAULT 0 CHECK (charges >= 0),
  added INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
  already INTEGER NOT NULL DEFAULT 0 CHECK (already >= 0),
  remembered INTEGER NOT NULL DEFAULT 0 CHECK (remembered >= 0),
  -- Payments to the card in the file, left out: they're paid from the bank in NetSuite.
  payments INTEGER NOT NULL DEFAULT 0 CHECK (payments >= 0),
  imported_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_charge_imports_card_idx ON card_charge_imports (card_account_netsuite_id, created_at DESC);

-- ── Each press of Send ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_charge_sends (
  -- Made by the page; the journal entry's External ID in NetSuite is 'fleetsuite-card-' and this.
  id UUID PRIMARY KEY,
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  card_account_netsuite_id TEXT NOT NULL CHECK (card_account_netsuite_id ~ '^[0-9]+$'),
  -- The first of the charges' month.
  month DATE NOT NULL CHECK (extract(day FROM month) = 1),
  -- What the claimed charges came to, and the journal entry's date (the latest charge's).
  charge_count INTEGER CHECK (charge_count >= 0),
  net_cents BIGINT,
  total_cents BIGINT CHECK (total_cents >= 0),
  tran_date DATE,
  claimed_at TIMESTAMPTZ,
  netsuite_journal_id TEXT CHECK (netsuite_journal_id ~ '^[0-9]+$'),
  netsuite_number TEXT,
  error TEXT,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_charge_sends_card_idx ON card_charge_sends (card_account_netsuite_id, created_at DESC);

-- ── The charges ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES card_charge_imports(id) ON DELETE RESTRICT,
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  card_account_netsuite_id TEXT NOT NULL CHECK (card_account_netsuite_id ~ '^[0-9]+$'),
  charge_date DATE NOT NULL,
  post_date DATE,
  description TEXT NOT NULL CHECK (btrim(description) <> '' AND length(description) <= 200),
  -- The merchant as FleetSuite remembers it (src/lib/card-charges.ts merchantKey).
  merchant_key TEXT NOT NULL,
  category TEXT,
  chase_type TEXT,
  -- What it puts on the card: above 0 for a charge or fee, below 0 for money back.
  cents BIGINT NOT NULL CHECK (cents <> 0),
  -- The card's last digits, when the download names the card.
  card TEXT,
  chase_memo TEXT,
  -- The same charge in another download has the same fingerprint.
  fingerprint TEXT NOT NULL CHECK (btrim(fingerprint) <> ''),
  -- The account it's coded to, and whether that came from the merchant's remembered account.
  account_netsuite_id TEXT CHECK (account_netsuite_id ~ '^[0-9]+$'),
  memo TEXT CHECK (length(memo) <= 300),
  remembered BOOLEAN NOT NULL DEFAULT false,
  coded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  coded_at TIMESTAMPTZ,
  -- The send that holds it: while that send is being made, or for good once it's made.
  send_id UUID REFERENCES card_charge_sends(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_account_netsuite_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS card_charges_card_month_idx ON card_charges (card_account_netsuite_id, charge_date) WHERE send_id IS NULL;
CREATE INDEX IF NOT EXISTS card_charges_send_idx ON card_charges (send_id) WHERE send_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS card_charges_import_idx ON card_charges (import_id);

CREATE TABLE IF NOT EXISTS card_merchant_rules (
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  merchant_key TEXT NOT NULL CHECK (btrim(merchant_key) <> ''),
  account_netsuite_id TEXT NOT NULL CHECK (account_netsuite_id ~ '^[0-9]+$'),
  -- How many charges have been coded to it since it became the merchant's account.
  times INTEGER NOT NULL DEFAULT 1 CHECK (times > 0),
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company, merchant_key)
);

-- ── Adding a file ──────────────────────────────────────────────────────────

-- Adds a file's charges. p:
--   { import_id, company, card_account_netsuite_id, file_name?, payments, imported_by?,
--     rows: [{ charge_date, post_date?, description, merchant_key, category?, chase_type?, cents, card?, chase_memo?,
--              fingerprint }] }
-- A charge the card already has (by its fingerprint) is left as it is. A new one from a merchant with a remembered
-- account comes in coded to it. The same import id again adds nothing. Returns { added, already, remembered, payments }.
CREATE OR REPLACE FUNCTION public.card_charges_import(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_import UUID := (p->>'import_id')::uuid;
  v_company TEXT := btrim(p->>'company');
  v_card TEXT := p->>'card_account_netsuite_id';
  v_rows JSONB := coalesce(p->'rows', '[]'::jsonb);
  v_inserted INTEGER;
  v_added INTEGER;
  v_remembered INTEGER;
  v_row public.card_charge_imports;
BEGIN
  IF jsonb_typeof(v_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'card charges: an import''s rows must be a list';
  END IF;
  INSERT INTO public.card_charge_imports (id, company, card_account_netsuite_id, file_name, charges, payments, imported_by)
  VALUES (v_import, v_company, v_card, nullif(btrim(p->>'file_name'), ''), jsonb_array_length(v_rows),
          coalesce((p->>'payments')::int, 0), nullif(p->>'imported_by', '')::uuid)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    SELECT * INTO v_row FROM public.card_charge_imports WHERE id = v_import;
    RETURN jsonb_build_object('added', v_row.added, 'already', v_row.already, 'remembered', v_row.remembered,
                              'payments', v_row.payments, 'again', true);
  END IF;

  INSERT INTO public.card_charges (
    import_id, company, card_account_netsuite_id, charge_date, post_date, description, merchant_key, category,
    chase_type, cents, card, chase_memo, fingerprint, account_netsuite_id, remembered
  )
  SELECT v_import, v_company, v_card, x.charge_date, x.post_date, x.description, coalesce(x.merchant_key, ''),
         nullif(x.category, ''), nullif(x.chase_type, ''), x.cents, nullif(x.card, ''), nullif(x.chase_memo, ''),
         x.fingerprint, r.account_netsuite_id, r.account_netsuite_id IS NOT NULL
  FROM jsonb_to_recordset(v_rows) AS x(
    charge_date DATE, post_date DATE, description TEXT, merchant_key TEXT, category TEXT, chase_type TEXT, cents BIGINT,
    card TEXT, chase_memo TEXT, fingerprint TEXT
  )
  LEFT JOIN public.card_merchant_rules r ON r.company = v_company AND r.merchant_key = x.merchant_key
  ON CONFLICT (card_account_netsuite_id, fingerprint) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  SELECT count(*) INTO v_remembered FROM public.card_charges WHERE import_id = v_import AND remembered;
  UPDATE public.card_charge_imports
  SET added = v_added, already = jsonb_array_length(v_rows) - v_added, remembered = v_remembered
  WHERE id = v_import;
  RETURN jsonb_build_object('added', v_added, 'already', jsonb_array_length(v_rows) - v_added, 'remembered', v_remembered,
                            'payments', coalesce((p->>'payments')::int, 0), 'again', false);
END;
$$;

-- ── Coding charges ─────────────────────────────────────────────────────────

-- Codes one card's charges that aren't sent. p: { card_account_netsuite_id, by?, changes: [{ id, account_netsuite_id?, memo? }] }
-- Each merchant coded to an account remembers it for the company, the account most of its charges went to in this
-- save. A charge held by a send, or another card's, stays as it is. Returns { coded, held }.
CREATE OR REPLACE FUNCTION public.card_charges_code(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_card TEXT := p->>'card_account_netsuite_id';
  v_by UUID := nullif(p->>'by', '')::uuid;
  v_changes JSONB := coalesce(p->'changes', '[]'::jsonb);
  v_coded INTEGER;
BEGIN
  IF jsonb_typeof(v_changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'card charges: the changes must be a list';
  END IF;

  WITH ch AS (
    SELECT * FROM jsonb_to_recordset(v_changes) AS x(id UUID, account_netsuite_id TEXT, memo TEXT)
  ), coded AS (
    UPDATE public.card_charges c
    SET account_netsuite_id = nullif(ch.account_netsuite_id, ''), memo = nullif(btrim(ch.memo), ''), remembered = false,
        coded_by = v_by, coded_at = now()
    FROM ch
    WHERE c.id = ch.id AND c.card_account_netsuite_id = v_card AND c.send_id IS NULL
    RETURNING c.company, c.merchant_key, c.account_netsuite_id
  ), counted AS (
    SELECT company, merchant_key, account_netsuite_id, count(*)::int AS n
    FROM coded
    WHERE account_netsuite_id IS NOT NULL AND btrim(merchant_key) <> ''
    GROUP BY company, merchant_key, account_netsuite_id
  ), learned AS (
    INSERT INTO public.card_merchant_rules (company, merchant_key, account_netsuite_id, times, updated_by, updated_at)
    SELECT DISTINCT ON (company, merchant_key) company, merchant_key, account_netsuite_id, n, v_by, now()
    FROM counted
    ORDER BY company, merchant_key, n DESC, account_netsuite_id
    ON CONFLICT (company, merchant_key) DO UPDATE
      SET account_netsuite_id = EXCLUDED.account_netsuite_id,
          times = CASE WHEN public.card_merchant_rules.account_netsuite_id = EXCLUDED.account_netsuite_id
                       THEN public.card_merchant_rules.times + EXCLUDED.times ELSE EXCLUDED.times END,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
    RETURNING 1
  )
  SELECT count(*) INTO v_coded FROM coded;

  RETURN jsonb_build_object('coded', v_coded, 'held', jsonb_array_length(v_changes) - v_coded);
END;
$$;

-- ── Sending a month ────────────────────────────────────────────────────────

-- Takes the claim for one press of Send. p:
--   { send_id, company, card_account_netsuite_id, month (YYYY-MM-01), max, created_by? }
-- Answers { state } with:
--   'made'      the press made its journal entry already (netsuite_journal_id, netsuite_number);
--   'making'    the press holds its charges and is being made (claimed_at, and its charges);
--   'uncoded'   some of the month's charges have no account yet (uncoded), and nothing is claimed;
--   'nothing'   the month has no charges to send;
--   'claimed'   this press now holds the month's oldest charges, up to max (charges).
-- A press NetSuite refused takes the claim again.
CREATE OR REPLACE FUNCTION public.card_charges_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_send UUID := (p->>'send_id')::uuid;
  v_card TEXT := p->>'card_account_netsuite_id';
  v_start DATE := (p->>'month')::date;
  v_end DATE := ((p->>'month')::date + INTERVAL '1 month')::date;
  v_max INTEGER := coalesce((p->>'max')::int, 250);
  v_row public.card_charge_sends;
  v_new BOOLEAN := false;
  v_uncoded INTEGER;
  v_charges JSONB;
BEGIN
  IF extract(day FROM v_start) <> 1 THEN
    RAISE EXCEPTION 'card charges: a send''s month starts on its first day';
  END IF;

  SELECT * INTO v_row FROM public.card_charge_sends WHERE id = v_send FOR UPDATE;
  IF FOUND THEN
    IF v_row.card_account_netsuite_id IS DISTINCT FROM v_card OR v_row.month IS DISTINCT FROM v_start THEN
      RAISE EXCEPTION 'card charges: send % is for another card or month', v_send;
    END IF;
    IF v_row.netsuite_journal_id IS NOT NULL THEN
      RETURN jsonb_build_object('state', 'made', 'netsuite_journal_id', v_row.netsuite_journal_id,
                                'netsuite_number', v_row.netsuite_number, 'charge_count', v_row.charge_count,
                                'total_cents', v_row.total_cents, 'net_cents', v_row.net_cents);
    END IF;
    IF v_row.claimed_at IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.charge_date, c.id), '[]'::jsonb) INTO v_charges
      FROM public.card_charges c WHERE c.send_id = v_send;
      RETURN jsonb_build_object('state', 'making', 'claimed_at', v_row.claimed_at, 'charges', v_charges);
    END IF;
    -- NetSuite refused this press before: it takes the claim again.
  END IF;

  SELECT count(*) INTO v_uncoded FROM public.card_charges
  WHERE card_account_netsuite_id = v_card AND send_id IS NULL AND account_netsuite_id IS NULL
    AND charge_date >= v_start AND charge_date < v_end;
  IF v_uncoded > 0 THEN
    RETURN jsonb_build_object('state', 'uncoded', 'uncoded', v_uncoded);
  END IF;

  IF v_row.id IS NULL THEN
    INSERT INTO public.card_charge_sends (id, company, card_account_netsuite_id, month, created_by)
    VALUES (v_send, btrim(p->>'company'), v_card, v_start, nullif(p->>'created_by', '')::uuid)
    ON CONFLICT (id) DO NOTHING;
    v_new := FOUND;
    IF NOT v_new THEN
      -- The same press, at the same moment: it holds the claim, or says what it did.
      SELECT * INTO v_row FROM public.card_charge_sends WHERE id = v_send FOR UPDATE;
      RETURN CASE WHEN v_row.netsuite_journal_id IS NOT NULL
        THEN jsonb_build_object('state', 'made', 'netsuite_journal_id', v_row.netsuite_journal_id,
                                'netsuite_number', v_row.netsuite_number, 'charge_count', v_row.charge_count,
                                'total_cents', v_row.total_cents, 'net_cents', v_row.net_cents)
        ELSE jsonb_build_object('state', 'making', 'claimed_at', v_row.claimed_at,
                                'charges', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.charge_date, c.id), '[]'::jsonb)
                                            FROM public.card_charges c WHERE c.send_id = v_send))
      END;
    END IF;
  END IF;

  WITH picked AS (
    SELECT id FROM public.card_charges
    WHERE card_account_netsuite_id = v_card AND send_id IS NULL AND account_netsuite_id IS NOT NULL
      AND charge_date >= v_start AND charge_date < v_end
    ORDER BY charge_date, id
    LIMIT v_max
    FOR UPDATE SKIP LOCKED
  ), held AS (
    UPDATE public.card_charges c SET send_id = v_send FROM picked WHERE c.id = picked.id
    RETURNING c.*
  )
  SELECT coalesce(jsonb_agg(to_jsonb(held) ORDER BY held.charge_date, held.id), '[]'::jsonb) INTO v_charges FROM held;

  IF jsonb_array_length(v_charges) = 0 THEN
    IF v_new THEN
      DELETE FROM public.card_charge_sends WHERE id = v_send AND netsuite_journal_id IS NULL;
    END IF;
    RETURN jsonb_build_object('state', 'nothing');
  END IF;
  UPDATE public.card_charge_sends SET claimed_at = now(), error = NULL, updated_at = now() WHERE id = v_send;
  RETURN jsonb_build_object('state', 'claimed', 'charges', v_charges);
END;
$$;

-- Lets go of a send's charges, keeping why: NetSuite refused it, or what the page showed changed.
-- p: { send_id, error }. A send already made stays as it is. Returns { let_go } (how many charges).
CREATE OR REPLACE FUNCTION public.card_charges_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_send UUID := (p->>'send_id')::uuid;
  v_freed INTEGER := 0;
BEGIN
  UPDATE public.card_charge_sends
  SET claimed_at = NULL, error = left(coalesce(nullif(btrim(p->>'error'), ''), 'Not sent'), 2000), updated_at = now()
  WHERE id = v_send AND netsuite_journal_id IS NULL;
  IF FOUND THEN
    UPDATE public.card_charges SET send_id = NULL WHERE send_id = v_send;
    GET DIAGNOSTICS v_freed = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('let_go', v_freed);
END;
$$;

-- ── Books' own copy ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_journal_entries (
  -- NetSuite's internal id for the journal entry FleetSuite made; its lines are in the GL copy (gl_netsuite_lines).
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  -- What made it: 'card_charges', a month of a card's charges (card_charge_sends).
  source TEXT NOT NULL CHECK (source IN ('card_charges')),
  made_from_id UUID,
  netsuite_number TEXT,
  tran_date DATE NOT NULL,
  memo TEXT,
  -- How FleetSuite worked it out (card_charges@1: two lines a charge, each to the cent).
  rule TEXT NOT NULL CHECK (btrim(rule) <> ''),
  -- Its debits, which its credits match.
  total NUMERIC(14,2) NOT NULL CHECK (total > 0),
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_own_journal_entries_date ON gl_own_journal_entries(tran_date DESC, netsuite_id);

CREATE TABLE IF NOT EXISTS gl_own_journal_entry_lines (
  journal_entry_id TEXT NOT NULL REFERENCES gl_own_journal_entries(netsuite_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  account_netsuite_id TEXT NOT NULL CHECK (account_netsuite_id ~ '^[0-9]+$'),
  debit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo TEXT,
  -- The card charge the line is for, when it's for one.
  card_charge_id UUID,
  PRIMARY KEY (journal_entry_id, line_no),
  CHECK ((debit > 0) <> (credit > 0))
);

-- Saves Books' own copy of a journal entry FleetSuite just made. p:
--   { netsuite_id, company? ('BMG'), source, made_from_id?, netsuite_number?, tran_date, memo?, rule, total, made_by?,
--     lines: [{ line_no, account_netsuite_id, debit?, credit?, memo?, card_charge_id? }] }
-- Its debits must match its credits and its total. A copy of that journal entry already saved stays as it is.
-- Returns { saved, lines }.
CREATE OR REPLACE FUNCTION public.gl_own_journal_entry_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id TEXT := p->>'netsuite_id';
  v_company UUID;
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_debits NUMERIC;
  v_credits NUMERIC;
  v_inserted INTEGER;
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: an own journal entry needs NetSuite''s id for the journal entry';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = coalesce(p->>'company', 'BMG');
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(p->>'company', 'BMG');
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(v_lines) < 2 THEN
    RAISE EXCEPTION 'gl: own journal entry % needs two lines or more', v_id;
  END IF;
  SELECT coalesce(sum(coalesce((x.v->>'debit')::numeric, 0)), 0), coalesce(sum(coalesce((x.v->>'credit')::numeric, 0)), 0)
  INTO v_debits, v_credits
  FROM jsonb_array_elements(v_lines) AS x(v);
  IF v_debits IS DISTINCT FROM v_credits OR v_debits IS DISTINCT FROM (p->>'total')::numeric THEN
    RAISE EXCEPTION 'gl: own journal entry %''s debits and credits don''t match its total', v_id;
  END IF;

  INSERT INTO public.gl_own_journal_entries (
    netsuite_id, company_id, source, made_from_id, netsuite_number, tran_date, memo, rule, total, made_by
  ) VALUES (
    v_id, v_company, p->>'source', nullif(p->>'made_from_id', '')::uuid, nullif(btrim(p->>'netsuite_number'), ''),
    (p->>'tran_date')::date, nullif(btrim(p->>'memo'), ''), p->>'rule', (p->>'total')::numeric,
    nullif(p->>'made_by', '')::uuid
  )
  ON CONFLICT (netsuite_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('saved', false, 'lines', 0);
  END IF;

  INSERT INTO public.gl_own_journal_entry_lines (journal_entry_id, line_no, account_netsuite_id, debit, credit, memo, card_charge_id)
  SELECT v_id, x.line_no, x.account_netsuite_id, coalesce(x.debit, 0), coalesce(x.credit, 0), nullif(x.memo, ''),
         nullif(x.card_charge_id, '')::uuid
  FROM jsonb_to_recordset(v_lines) AS x(
    line_no INTEGER, account_netsuite_id TEXT, debit NUMERIC, credit NUMERIC, memo TEXT, card_charge_id TEXT
  );

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
  FOREACH t IN ARRAY ARRAY['card_charge_imports', 'card_charge_sends', 'card_charges', 'card_merchant_rules',
                           'gl_own_journal_entries', 'gl_own_journal_entry_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.card_charges_import(jsonb)', 'public.card_charges_code(jsonb)',
                           'public.card_charges_claim(jsonb)', 'public.card_charges_let_go(jsonb)',
                           'public.gl_own_journal_entry_save(jsonb)'] LOOP
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

COMMENT ON TABLE card_charge_imports IS 'Migration 468: one row per Chase card download added on the Card charges page (src/lib/card-charges.ts, /api/card-charges): how many charges were new, already here, or came in coded to the merchant''s remembered account, and the payments to the card left out. Service-role write and read.';
COMMENT ON TABLE card_charges IS 'Migration 468: one row per Chase card charge, kept once per card by its fingerprint, with the account it''s coded to and the send that holds it once it''s being sent or sent. Service-role write and read.';
COMMENT ON TABLE card_merchant_rules IS 'Migration 468: the account each merchant''s card charges last went to, per company, filled in on new charges from that merchant. Service-role write and read.';
COMMENT ON TABLE card_charge_sends IS 'Migration 468: one row per press of Send on the Card charges page: the claim that keeps one press to one NetSuite journal entry (its External ID is fleetsuite-card- and this id), what it sent, and what NetSuite made or why it refused. Service-role write and read.';
COMMENT ON TABLE gl_own_journal_entries IS 'Migration 468: Books'' own copy of each journal entry FleetSuite makes in NetSuite (src/lib/books/own-journal-entries.ts), saved only by gl_own_journal_entry_save, by NetSuite''s id for the journal entry. Not checked against NetSuite''s or posted yet. Service-role write and read.';
COMMENT ON TABLE gl_own_journal_entry_lines IS 'Migration 468: the lines of Books'' own journal entries (gl_own_journal_entries), each a debit or a credit, with the card charge it''s for. Service-role write and read.';
COMMENT ON FUNCTION public.card_charges_import(jsonb) IS 'Migration 468: adds a Chase download''s charges, once per card by fingerprint, coded to the merchant''s remembered account where there is one. Service role only.';
COMMENT ON FUNCTION public.card_charges_code(jsonb) IS 'Migration 468: codes card charges that aren''t sent and remembers each merchant''s account. Service role only.';
COMMENT ON FUNCTION public.card_charges_claim(jsonb) IS 'Migration 468: takes the claim for one press of Send on a card''s month of charges, or says what the press did already. Service role only.';
COMMENT ON FUNCTION public.card_charges_let_go(jsonb) IS 'Migration 468: lets go of a send''s charges and keeps why it wasn''t made. Service role only.';
COMMENT ON FUNCTION public.gl_own_journal_entry_save(jsonb) IS 'Migration 468: saves Books'' own copy of a journal entry FleetSuite just made, refusing one whose debits and credits don''t match its total; one already saved stays as it is. Service role only.';
