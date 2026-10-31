-- Migration 470: FleetSuite's own books, part 38 — inventory transfers made in
-- FleetSuite and sent to NetSuite, switched off until January 1, 2027.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking; each piece that takes
-- them out of NetSuite is built switched off, and FleetSuite sends its
-- document on to NetSuite. Inventory transfers come fifth: stock moved from
-- one of a company's locations to another is moved in FleetSuite, and
-- FleetSuite makes NetSuite's Transfer Inventory for it, once
-- (src/lib/inventory-transfers.ts, /api/inventory-transfers, page
-- /admin/inventory-transfers, docs/books.md "Inventory transfers made in
-- FleetSuite").
--
--   * books_switches takes a fifth piece, inventory_transfers, off;
--   * inventory_transfers, one row per transfer. Its id comes from the page
--     and is the transfer's External ID in NetSuite, so pressing Move again
--     never moves the stock twice. It goes draft → sending (being made in
--     NetSuite) → made, and back to draft when NetSuite doesn't make it.
--     Only a draft can be changed, and a send names the draft as the sender
--     saw it, so it can't move lines that changed after they looked.
--
-- Nothing here is money: a transfer moves stock between locations of one
-- company, at the cost NetSuite carries it at. Books already copies every
-- NetSuite transfer (migration 401's stock copy and the GL copy), so the one
-- FleetSuite makes is counted and posted from that copy as any other.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 469 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all five.
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
  CHECK (piece IN ('credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers'));

INSERT INTO books_switches (piece) VALUES ('inventory_transfers') ON CONFLICT (piece) DO NOTHING;

-- ── The transfers ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inventory_transfers (
  -- Made by the page when the transfer is started; its External ID in NetSuite is 'fleetsuite-it-' and this.
  id UUID PRIMARY KEY,
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  tran_date DATE NOT NULL,
  -- NetSuite's ids for the locations it moves from and to.
  from_location_id TEXT CHECK (from_location_id ~ '^[0-9]+$'),
  to_location_id TEXT CHECK (to_location_id ~ '^[0-9]+$'),
  memo TEXT CHECK (length(memo) <= 300),
  -- The lines as typed, in order: [{ item_netsuite_id, item_number, quantity }].
  lines JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'made')),
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The press that's making it in NetSuite, or made it.
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  netsuite_transfer_id TEXT CHECK (netsuite_transfer_id ~ '^[0-9]+$'),
  netsuite_number TEXT,
  -- Why NetSuite didn't make it, the last time it was sent.
  error TEXT CHECK (length(error) <= 2000),
  CHECK ((status = 'made') = (netsuite_transfer_id IS NOT NULL)),
  CHECK (status = 'draft' OR sent_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS inventory_transfers_status_idx ON inventory_transfers (status, updated_at DESC);

-- Saves a draft, new or changed. p:
--   { id, company, tran_date, from_location_id?, to_location_id?, memo?,
--     lines: [{ item_netsuite_id?, item_number?, quantity }], by? }
-- A line's item is NetSuite's id, or none yet; its quantity is 0 or more, to four places, 1,000,000 at most.
-- Only a draft changes: a transfer being made or made stays as it is. Returns { saved, status, updated_at }.
CREATE OR REPLACE FUNCTION public.inventory_transfer_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_kept JSONB;
  v_row public.inventory_transfers;
BEGIN
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'inventory transfers: a transfer''s lines must be a list';
  END IF;
  IF jsonb_array_length(v_lines) > 100 THEN
    RAISE EXCEPTION 'inventory transfers: a transfer takes 100 lines at most';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_lines) AS x(v)
    WHERE jsonb_typeof(x.v) IS DISTINCT FROM 'object'
       OR coalesce(jsonb_typeof(x.v->'item_netsuite_id'), 'null') NOT IN ('null', 'string')
       OR (jsonb_typeof(x.v->'item_netsuite_id') = 'string' AND (x.v->>'item_netsuite_id') !~ '^[0-9]+$')
       OR coalesce(jsonb_typeof(x.v->'item_number'), 'null') NOT IN ('null', 'string')
       OR length(coalesce(x.v->>'item_number', '')) > 200
       OR jsonb_typeof(x.v->'quantity') IS DISTINCT FROM 'number'
       OR (x.v->>'quantity')::numeric < 0
       OR (x.v->>'quantity')::numeric > 1000000
       OR (x.v->>'quantity')::numeric <> round((x.v->>'quantity')::numeric, 4)
  ) THEN
    RAISE EXCEPTION 'inventory transfers: each line is an item (NetSuite''s id) and a quantity of 0 or more, to four places';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'item_netsuite_id', x.v->>'item_netsuite_id',
           'item_number', nullif(btrim(coalesce(x.v->>'item_number', '')), ''),
           'quantity', (x.v->>'quantity')::numeric
         ) ORDER BY x.n), '[]'::jsonb)
  INTO v_kept
  FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS x(v, n);

  INSERT INTO public.inventory_transfers (id, company, tran_date, from_location_id, to_location_id, memo, lines, created_by, updated_by)
  VALUES (v_id, btrim(p->>'company'), (p->>'tran_date')::date, nullif(p->>'from_location_id', ''), nullif(p->>'to_location_id', ''),
          nullif(btrim(coalesce(p->>'memo', '')), ''), v_kept, nullif(p->>'by', '')::uuid, nullif(p->>'by', '')::uuid)
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('saved', true, 'status', v_row.status, 'updated_at', v_row.updated_at);
  END IF;

  SELECT * INTO v_row FROM public.inventory_transfers WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Deleted between the two.
    RETURN jsonb_build_object('saved', false, 'status', 'gone');
  END IF;
  IF v_row.status <> 'draft' THEN
    RETURN jsonb_build_object('saved', false, 'status', v_row.status, 'updated_at', v_row.updated_at);
  END IF;
  UPDATE public.inventory_transfers
  SET company = btrim(p->>'company'), tran_date = (p->>'tran_date')::date,
      from_location_id = nullif(p->>'from_location_id', ''), to_location_id = nullif(p->>'to_location_id', ''),
      memo = nullif(btrim(coalesce(p->>'memo', '')), ''), lines = v_kept,
      updated_by = nullif(p->>'by', '')::uuid, updated_at = now()
  WHERE id = v_id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('saved', true, 'status', v_row.status, 'updated_at', v_row.updated_at);
END;
$$;

-- Takes the claim for a press of Move. p: { id, by, updated_at } — updated_at is the draft as the sender saw it.
-- The draft must be whole: a memo, two different locations, and one line or more, each an item moving more
-- than 0 (the route checks each item and location first; src/lib/inventory-transfers.ts).
-- Answers { state } with:
--   'made'      it's in NetSuite already (netsuite_transfer_id, netsuite_number);
--   'moving'    a press holds it and is making it (transfer);
--   'claimed'   this press now holds it (transfer);
--   'changed'   it was saved again since the sender looked;
--   'gone'.
-- A press NetSuite refused lets go of it (inventory_transfer_let_go), and it's a draft again.
CREATE OR REPLACE FUNCTION public.inventory_transfer_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.inventory_transfers;
  v_count INTEGER;
  v_bad INTEGER;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'inventory transfers: a send needs who sent it';
  END IF;
  SELECT * INTO v_row FROM public.inventory_transfers WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status = 'made' THEN
    RETURN jsonb_build_object('state', 'made', 'netsuite_transfer_id', v_row.netsuite_transfer_id, 'netsuite_number', v_row.netsuite_number);
  END IF;
  IF v_row.status = 'sending' THEN
    RETURN jsonb_build_object('state', 'moving', 'transfer', to_jsonb(v_row));
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'updated_at')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;

  SELECT count(*), count(*) FILTER (WHERE x.item_netsuite_id IS NULL OR coalesce(x.quantity, 0) <= 0)
  INTO v_count, v_bad
  FROM jsonb_to_recordset(v_row.lines) AS x(item_netsuite_id TEXT, quantity NUMERIC);
  IF v_count < 1 OR v_bad > 0 OR v_row.from_location_id IS NULL OR v_row.to_location_id IS NULL
     OR v_row.from_location_id = v_row.to_location_id OR nullif(btrim(coalesce(v_row.memo, '')), '') IS NULL THEN
    RAISE EXCEPTION 'inventory transfers: transfer % needs a memo, two different locations and one line or more, each an item and a quantity', v_row.id;
  END IF;

  UPDATE public.inventory_transfers
  SET status = 'sending', sent_by = (p->>'by')::uuid, sent_at = now(), error = NULL
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'claimed', 'transfer', to_jsonb(v_row));
END;
$$;

-- Lets go of a press that didn't make the transfer, keeping why: it's a draft again, as the sender saw it, so
-- Move can be pressed again. p: { id, error }. Returns { let_go }.
CREATE OR REPLACE FUNCTION public.inventory_transfer_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.inventory_transfers
  SET status = 'draft', sent_by = NULL, sent_at = NULL,
      error = left(coalesce(nullif(btrim(p->>'error'), ''), 'Not made'), 2000)
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('let_go', FOUND);
END;
$$;

-- Keeps the transfer NetSuite made for a press. p: { id, netsuite_transfer_id, netsuite_number? }.
-- Returns { made } — false when the transfer isn't being made (made already, or let go).
CREATE OR REPLACE FUNCTION public.inventory_transfer_made(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(p->>'netsuite_transfer_id', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'inventory transfers: a made transfer needs NetSuite''s id for it';
  END IF;
  UPDATE public.inventory_transfers
  SET status = 'made', netsuite_transfer_id = p->>'netsuite_transfer_id', netsuite_number = nullif(btrim(p->>'netsuite_number'), ''),
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
  ALTER TABLE public.inventory_transfers ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.inventory_transfers FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.inventory_transfer_save(jsonb)', 'public.inventory_transfer_claim(jsonb)',
                           'public.inventory_transfer_let_go(jsonb)', 'public.inventory_transfer_made(jsonb)'] LOOP
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

COMMENT ON TABLE inventory_transfers IS 'Migration 470: one row per inventory transfer made on the Inventory transfers page (src/lib/inventory-transfers.ts, /api/inventory-transfers): the locations it moves from and to, its lines as typed, who pressed Move, and the transfer NetSuite made (its External ID is fleetsuite-it- and this id). Moved only by its functions and the route''s delete of a draft. Service-role write and read.';
COMMENT ON FUNCTION public.inventory_transfer_save(jsonb) IS 'Migration 470: saves a draft inventory transfer, new or changed; one being made or made stays as it is. Service role only.';
COMMENT ON FUNCTION public.inventory_transfer_claim(jsonb) IS 'Migration 470: takes the claim for a press of Move of the draft the sender saw, or says what became of it. Service role only.';
COMMENT ON FUNCTION public.inventory_transfer_let_go(jsonb) IS 'Migration 470: lets go of a press NetSuite didn''t make, keeping why; the transfer is a draft again. Service role only.';
COMMENT ON FUNCTION public.inventory_transfer_made(jsonb) IS 'Migration 470: keeps the transfer NetSuite made for a press. Service role only.';
