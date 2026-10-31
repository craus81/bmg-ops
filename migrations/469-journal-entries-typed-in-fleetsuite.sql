-- Migration 469: FleetSuite's own books, part 37 — journal entries typed in
-- FleetSuite, approved, and sent to NetSuite, switched off until January 1,
-- 2027.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking; each piece that takes
-- them out of NetSuite is built switched off, and FleetSuite sends its
-- document on to NetSuite. Journal entries come fourth: the entries the
-- bookkeeper types into NetSuite's books today are typed in FleetSuite,
-- asked for approval, approved by a super admin who didn't ask, and made in
-- NetSuite exactly as typed (src/lib/typed-journal-entries.ts,
-- /api/journal-entries, page /admin/journal-entries, docs/books.md "Journal
-- entries typed in FleetSuite").
--
--   * books_switches takes a fourth piece, journal_entries, off;
--   * typed_journal_entries, one row per entry. Its id comes from the page
--     and is the journal entry's External ID in NetSuite, so approving it
--     again never makes a second one. It goes draft → waiting (asked for
--     approval) → sending (approved, being made in NetSuite) → made, and
--     back to draft when it's taken back or sent back with a reason. Only a
--     draft can be changed, and an approval names the ask it approves, so
--     it can't land on lines that changed after the approver looked;
--   * gl_own_journal_entries (migration 468) takes a second source, typed,
--     for Books' own copy of each one made.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 468 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all four.
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
  CHECK (piece IN ('credit_memos', 'vendor_credits', 'card_charges', 'journal_entries'));

INSERT INTO books_switches (piece) VALUES ('journal_entries') ON CONFLICT (piece) DO NOTHING;

-- ── Books' own copy takes typed entries ────────────────────────────────────

DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.gl_own_journal_entries'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%source%'
  LOOP
    EXECUTE format('ALTER TABLE public.gl_own_journal_entries DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE gl_own_journal_entries ADD CONSTRAINT gl_own_journal_entries_source_check
  CHECK (source IN ('card_charges', 'typed'));

COMMENT ON COLUMN gl_own_journal_entries.source IS
  'What made it: card_charges, a month of a card''s charges (card_charge_sends, migration 468); typed, an entry typed on the Journal entries page (typed_journal_entries, migration 469).';

-- ── The entries ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS typed_journal_entries (
  -- Made by the page when the entry is started; the journal entry's External ID in NetSuite is 'fleetsuite-je-' and this.
  id UUID PRIMARY KEY,
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  tran_date DATE NOT NULL,
  memo TEXT CHECK (length(memo) <= 300),
  -- The lines as typed, in order: [{ account_netsuite_id, debit_cents, credit_cents, memo }].
  lines JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array'),
  -- What its lines' debits come to.
  total_cents BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'waiting', 'sending', 'made')),
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
  -- The approval that's making it in NetSuite, or made it.
  approved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  netsuite_journal_id TEXT CHECK (netsuite_journal_id ~ '^[0-9]+$'),
  netsuite_number TEXT,
  -- Why NetSuite didn't make it, the last time it was approved.
  error TEXT CHECK (length(error) <= 2000),
  CHECK ((status = 'made') = (netsuite_journal_id IS NOT NULL)),
  CHECK (status = 'draft' OR asked_at IS NOT NULL),
  CHECK (status NOT IN ('sending', 'made') OR approved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS typed_journal_entries_status_idx ON typed_journal_entries (status, updated_at DESC);

-- Saves a draft, new or changed. p:
--   { id, company, tran_date, memo?, lines: [{ account_netsuite_id?, debit_cents, credit_cents, memo? }], by? }
-- A line's account is NetSuite's id, or none yet; its amounts are whole cents, $0 or more. Only a draft changes:
-- an entry asked for approval, being made or made stays as it is. Returns { saved, status, updated_at }.
CREATE OR REPLACE FUNCTION public.typed_journal_entry_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_kept JSONB;
  v_total BIGINT;
  v_row public.typed_journal_entries;
BEGIN
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'typed journal entries: an entry''s lines must be a list';
  END IF;
  IF jsonb_array_length(v_lines) > 200 THEN
    RAISE EXCEPTION 'typed journal entries: an entry takes 200 lines at most';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_lines) AS x(v)
    WHERE jsonb_typeof(x.v) IS DISTINCT FROM 'object'
       OR coalesce(jsonb_typeof(x.v->'account_netsuite_id'), 'null') NOT IN ('null', 'string')
       OR (jsonb_typeof(x.v->'account_netsuite_id') = 'string' AND (x.v->>'account_netsuite_id') !~ '^[0-9]+$')
       OR jsonb_typeof(x.v->'debit_cents') IS DISTINCT FROM 'number'
       OR jsonb_typeof(x.v->'credit_cents') IS DISTINCT FROM 'number'
       OR (x.v->>'debit_cents')::numeric < 0 OR (x.v->>'credit_cents')::numeric < 0
       OR (x.v->>'debit_cents')::numeric <> trunc((x.v->>'debit_cents')::numeric)
       OR (x.v->>'credit_cents')::numeric <> trunc((x.v->>'credit_cents')::numeric)
       OR (x.v->>'debit_cents')::numeric > 10000000000 OR (x.v->>'credit_cents')::numeric > 10000000000
       OR length(coalesce(x.v->>'memo', '')) > 300
  ) THEN
    RAISE EXCEPTION 'typed journal entries: each line is an account (NetSuite''s id) and whole cents of $0 or more';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_netsuite_id', x.v->>'account_netsuite_id',
           'debit_cents', (x.v->>'debit_cents')::bigint,
           'credit_cents', (x.v->>'credit_cents')::bigint,
           'memo', nullif(btrim(coalesce(x.v->>'memo', '')), '')
         ) ORDER BY x.n), '[]'::jsonb),
         coalesce(sum((x.v->>'debit_cents')::bigint), 0)
  INTO v_kept, v_total
  FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS x(v, n);

  INSERT INTO public.typed_journal_entries (id, company, tran_date, memo, lines, total_cents, created_by, updated_by)
  VALUES (v_id, btrim(p->>'company'), (p->>'tran_date')::date, nullif(btrim(coalesce(p->>'memo', '')), ''), v_kept, v_total,
          nullif(p->>'by', '')::uuid, nullif(p->>'by', '')::uuid)
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('saved', true, 'status', v_row.status, 'updated_at', v_row.updated_at);
  END IF;

  SELECT * INTO v_row FROM public.typed_journal_entries WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Deleted between the two.
    RETURN jsonb_build_object('saved', false, 'status', 'gone');
  END IF;
  IF v_row.status <> 'draft' THEN
    RETURN jsonb_build_object('saved', false, 'status', v_row.status, 'updated_at', v_row.updated_at);
  END IF;
  UPDATE public.typed_journal_entries
  SET company = btrim(p->>'company'), tran_date = (p->>'tran_date')::date, memo = nullif(btrim(coalesce(p->>'memo', '')), ''),
      lines = v_kept, total_cents = v_total, updated_by = nullif(p->>'by', '')::uuid, updated_at = now()
  WHERE id = v_id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('saved', true, 'status', v_row.status, 'updated_at', v_row.updated_at);
END;
$$;

-- Asks for approval of a draft. p: { id, by?, updated_at } — updated_at is the draft as the asker saw it.
-- The draft must be whole: a memo, two lines or more, each an account and a debit or a credit above $0, and its
-- debits matching its credits (the route checks each line's account first; src/lib/typed-journal-entries.ts).
-- Answers { state }: 'asked' (asked_at), 'changed' (it was saved again since), 'gone', or where it is now.
CREATE OR REPLACE FUNCTION public.typed_journal_entry_ask(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.typed_journal_entries;
  v_count INTEGER;
  v_bad INTEGER;
  v_debits BIGINT;
  v_credits BIGINT;
BEGIN
  SELECT * INTO v_row FROM public.typed_journal_entries WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'draft' THEN
    RETURN jsonb_build_object('state', v_row.status);
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'updated_at')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE x.account_netsuite_id IS NULL OR (x.debit_cents > 0) = (x.credit_cents > 0)),
         coalesce(sum(x.debit_cents), 0), coalesce(sum(x.credit_cents), 0)
  INTO v_count, v_bad, v_debits, v_credits
  FROM jsonb_to_recordset(v_row.lines) AS x(account_netsuite_id TEXT, debit_cents BIGINT, credit_cents BIGINT);
  IF v_count < 2 OR v_bad > 0 OR v_debits <> v_credits OR nullif(btrim(coalesce(v_row.memo, '')), '') IS NULL THEN
    RAISE EXCEPTION 'typed journal entries: entry % needs a memo and two lines or more, each an account and a debit or a credit, that balance', v_row.id;
  END IF;

  UPDATE public.typed_journal_entries
  SET status = 'waiting', asked_by = nullif(p->>'by', '')::uuid, asked_at = now(),
      returned_by = NULL, returned_at = NULL, returned_reason = NULL, error = NULL
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'asked', 'asked_at', v_row.asked_at);
END;
$$;

-- Takes an entry asked for approval back to a draft, to change it. p: { id, by? }.
-- Answers { state }: 'taken_back', or where it is when it isn't waiting ('gone' when there's no such entry).
CREATE OR REPLACE FUNCTION public.typed_journal_entry_take_back(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.typed_journal_entries;
BEGIN
  SELECT * INTO v_row FROM public.typed_journal_entries WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'waiting' THEN
    RETURN jsonb_build_object('state', v_row.status);
  END IF;
  UPDATE public.typed_journal_entries
  SET status = 'draft', asked_by = NULL, asked_at = NULL, updated_by = nullif(p->>'by', '')::uuid, updated_at = now()
  WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'taken_back');
END;
$$;

-- Sends an entry asked for approval back to be fixed, with why. p: { id, by?, reason }.
-- Answers { state }: 'sent_back', or where it is when it isn't waiting ('gone' when there's no such entry).
CREATE OR REPLACE FUNCTION public.typed_journal_entry_send_back(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.typed_journal_entries;
  v_reason TEXT := nullif(btrim(coalesce(p->>'reason', '')), '');
BEGIN
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'typed journal entries: sending an entry back needs a reason';
  END IF;
  SELECT * INTO v_row FROM public.typed_journal_entries WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'waiting' THEN
    RETURN jsonb_build_object('state', v_row.status);
  END IF;
  UPDATE public.typed_journal_entries
  SET status = 'draft', asked_by = NULL, asked_at = NULL, returned_by = nullif(p->>'by', '')::uuid, returned_at = now(),
      returned_reason = left(v_reason, 500), updated_at = now()
  WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'sent_back');
END;
$$;

-- Takes the claim for an approval. p: { id, approver, asked_at } — asked_at is the ask as the approver saw it.
-- Answers { state } with:
--   'made'      it's in NetSuite already (netsuite_journal_id, netsuite_number);
--   'making'    an approval holds it and is making it (entry);
--   'claimed'   this approval now holds it (entry);
--   'changed'   it was taken back or asked again since the approver looked;
--   'yours'     the approver is the one who asked;
--   'draft' or 'gone'.
-- An approval NetSuite refused lets go of it (typed_journal_entry_let_go), and it can be approved again.
CREATE OR REPLACE FUNCTION public.typed_journal_entry_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.typed_journal_entries;
BEGIN
  IF nullif(p->>'approver', '') IS NULL THEN
    RAISE EXCEPTION 'typed journal entries: an approval needs who approved it';
  END IF;
  SELECT * INTO v_row FROM public.typed_journal_entries WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status = 'made' THEN
    RETURN jsonb_build_object('state', 'made', 'netsuite_journal_id', v_row.netsuite_journal_id, 'netsuite_number', v_row.netsuite_number);
  END IF;
  IF v_row.status = 'sending' THEN
    RETURN jsonb_build_object('state', 'making', 'entry', to_jsonb(v_row));
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
  UPDATE public.typed_journal_entries
  SET status = 'sending', approved_by = (p->>'approver')::uuid, approved_at = now(), error = NULL
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'claimed', 'entry', to_jsonb(v_row));
END;
$$;

-- Lets go of an approval that didn't make the entry, keeping why: it's waiting for approval again.
-- p: { id, error }. Returns { let_go }.
CREATE OR REPLACE FUNCTION public.typed_journal_entry_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.typed_journal_entries
  SET status = 'waiting', approved_by = NULL, approved_at = NULL,
      error = left(coalesce(nullif(btrim(p->>'error'), ''), 'Not made'), 2000)
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('let_go', FOUND);
END;
$$;

-- Keeps the journal entry NetSuite made for an approval. p: { id, netsuite_journal_id, netsuite_number? }.
-- Returns { made } — false when the entry isn't being made (made already, or let go).
CREATE OR REPLACE FUNCTION public.typed_journal_entry_made(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(p->>'netsuite_journal_id', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'typed journal entries: a made entry needs NetSuite''s id for its journal entry';
  END IF;
  UPDATE public.typed_journal_entries
  SET status = 'made', netsuite_journal_id = p->>'netsuite_journal_id', netsuite_number = nullif(btrim(p->>'netsuite_number'), ''),
      error = NULL
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('made', FOUND);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE public.typed_journal_entries ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.typed_journal_entries FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.typed_journal_entry_save(jsonb)', 'public.typed_journal_entry_ask(jsonb)',
                           'public.typed_journal_entry_take_back(jsonb)', 'public.typed_journal_entry_send_back(jsonb)',
                           'public.typed_journal_entry_claim(jsonb)', 'public.typed_journal_entry_let_go(jsonb)',
                           'public.typed_journal_entry_made(jsonb)'] LOOP
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

COMMENT ON TABLE typed_journal_entries IS 'Migration 469: one row per journal entry typed on the Journal entries page (src/lib/typed-journal-entries.ts, /api/journal-entries): its lines as typed, who asked for approval, who sent it back and why, who approved it, and the journal entry NetSuite made (its External ID is fleetsuite-je- and this id). Moved only by its functions. Service-role write and read.';
COMMENT ON FUNCTION public.typed_journal_entry_save(jsonb) IS 'Migration 469: saves a draft journal entry, new or changed; an entry asked for approval or made stays as it is. Service role only.';
COMMENT ON FUNCTION public.typed_journal_entry_ask(jsonb) IS 'Migration 469: asks for approval of a whole, balanced draft, as the asker saw it. Service role only.';
COMMENT ON FUNCTION public.typed_journal_entry_take_back(jsonb) IS 'Migration 469: takes an entry asked for approval back to a draft. Service role only.';
COMMENT ON FUNCTION public.typed_journal_entry_send_back(jsonb) IS 'Migration 469: sends an entry asked for approval back to be fixed, with why. Service role only.';
COMMENT ON FUNCTION public.typed_journal_entry_claim(jsonb) IS 'Migration 469: takes the claim for an approval of the ask the approver saw, by someone who didn''t ask, or says what became of it. Service role only.';
COMMENT ON FUNCTION public.typed_journal_entry_let_go(jsonb) IS 'Migration 469: lets go of an approval NetSuite didn''t make, keeping why; the entry waits for approval again. Service role only.';
COMMENT ON FUNCTION public.typed_journal_entry_made(jsonb) IS 'Migration 469: keeps the journal entry NetSuite made for an approval. Service role only.';
