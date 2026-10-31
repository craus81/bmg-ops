-- Migration 472: FleetSuite's own books, part 40 — bills fixed in FleetSuite
-- after they're made and sent on to NetSuite, switched off until January 1,
-- 2027.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking; each piece that takes
-- them out of NetSuite is built switched off, and FleetSuite sends its
-- document on to NetSuite. Fixing a bill comes seventh: its number, memo and
-- due date, and while nothing on it is paid or credited its date and lines,
-- changed in FleetSuite and in NetSuite (src/lib/bill-fix.ts,
-- /api/purchasing/bill-fix, page /admin/purchasing/bill-fix, docs/books.md
-- "Bills fixed in FleetSuite"). Undoing a whole bill isn't a fix: it's a
-- vendor credit for all of it (part 35, migration 467).
--
--   * books_switches takes a seventh piece, bill_fixes, off;
--   * bill_fixes, one row per press of Fix bill, as invoice_fixes is for
--     invoices (migration 471). Its id comes from the page, so a second press
--     of the same form never sends the fix twice, and only one fix of a bill
--     is sent at a time. It goes sending → fixed, or refused (NetSuite said
--     no, so nothing changed) or unsure (NetSuite didn't answer, so it may
--     have changed). A send that never finished holds the bill five minutes
--     at most;
--   * gl_own_bills gains a version: when FleetSuite fixes a bill it has its
--     own copy of, gl_own_bill_fix makes the copy's next version from the
--     fix, keeping each version before in gl_own_bill_versions. Saving a copy
--     (gl_own_bill_save) still never changes one. gl_own_bill_pairs gives the
--     check each copy's version and when it was last fixed.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 471 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all seven.
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
                   'bill_fixes'));

INSERT INTO books_switches (piece) VALUES ('bill_fixes') ON CONFLICT (piece) DO NOTHING;

-- ── The fixes ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bill_fixes (
  -- Made by the page when the screen opens: the same form pressed twice is one fix.
  id UUID PRIMARY KEY,
  bill_netsuite_id TEXT NOT NULL CHECK (bill_netsuite_id ~ '^[0-9]+$'),
  -- The vendor's number for the bill, before the fix.
  bill_number TEXT,
  vendor_netsuite_id TEXT CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT,
  reason TEXT NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 300),
  -- What changes, a sentence each, as the screen listed them.
  changes JSONB NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) > 0),
  -- What NetSuite was sent, and the lists it was told to make exactly the lines sent (a line taken off).
  patch JSONB NOT NULL CHECK (jsonb_typeof(patch) = 'object'),
  replace_lists TEXT[] NOT NULL DEFAULT '{}' CHECK (replace_lists <@ ARRAY['expense', 'item']::text[]),
  -- The total before, FleetSuite's working of it after, and NetSuite's once it answered.
  total_before_cents BIGINT,
  total_expected_cents BIGINT,
  total_after_cents BIGINT,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'fixed', 'refused', 'unsure')),
  -- NetSuite's reason, or why FleetSuite can't tell.
  error TEXT CHECK (length(error) <= 2000),
  -- What became of Books' own copy of the bill: 'fixed' (its next version), 'none' (it has none), 'not_saved'.
  own_copy TEXT CHECK (own_copy IN ('fixed', 'none', 'not_saved')),
  own_copy_version INTEGER CHECK (own_copy_version > 1),
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CHECK ((status = 'sending') = (finished_at IS NULL)),
  CHECK (own_copy IS NULL OR status = 'fixed'),
  CHECK ((own_copy = 'fixed') = (own_copy_version IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS bill_fixes_bill_idx ON bill_fixes (bill_netsuite_id, created_at DESC, id);
-- One fix of a bill at a time.
CREATE UNIQUE INDEX IF NOT EXISTS bill_fixes_one_sending ON bill_fixes (bill_netsuite_id) WHERE status = 'sending';

-- Takes the claim for a press of Fix bill. p:
--   { id, bill_netsuite_id, bill_number?, vendor_netsuite_id?, vendor_name?, reason, changes, patch, replace_lists?,
--     total_before_cents?, total_expected_cents?, by? }
-- Answers { claimed: true }, or { claimed: false, state } with:
--   'fixed'    this press fixed it already;
--   'sending'  this press is sending it now;
--   'busy'     another fix of the bill is being sent.
-- A press NetSuite refused, or didn't answer, can be pressed again: the route plans it against the bill as NetSuite
-- has it then. A send started more than five minutes ago that never finished is unsure, and lets go.
CREATE OR REPLACE FUNCTION public.bill_fix_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_bill TEXT := p->>'bill_netsuite_id';
  v_lists TEXT[] := coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'replace_lists', '[]'::jsonb))), '{}');
  v_row public.bill_fixes;
  v_had BOOLEAN;
BEGIN
  IF coalesce(v_bill, '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'bill fixes: a fix needs NetSuite''s id for the bill';
  END IF;
  -- One claimer of a bill at a time, so two presses can't both find it free.
  PERFORM pg_advisory_xact_lock(hashtext('bill_fix:' || v_bill));

  UPDATE public.bill_fixes
  SET status = 'unsure', finished_at = now(),
      error = 'FleetSuite stopped before NetSuite answered, so it can''t tell whether the fix went in. Check the bill in NetSuite.'
  WHERE bill_netsuite_id = v_bill AND status = 'sending' AND sent_at < now() - interval '5 minutes';

  SELECT * INTO v_row FROM public.bill_fixes WHERE id = v_id FOR UPDATE;
  v_had := FOUND;
  IF v_had THEN
    IF v_row.bill_netsuite_id <> v_bill THEN
      RAISE EXCEPTION 'bill fixes: % is a fix of another bill', v_id;
    END IF;
    IF v_row.status IN ('fixed', 'sending') THEN
      RETURN jsonb_build_object('claimed', false, 'state', v_row.status);
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.bill_fixes WHERE bill_netsuite_id = v_bill AND status = 'sending') THEN
    RETURN jsonb_build_object('claimed', false, 'state', 'busy');
  END IF;

  IF v_had THEN
    UPDATE public.bill_fixes
    SET bill_number = nullif(btrim(p->>'bill_number'), ''), vendor_netsuite_id = nullif(p->>'vendor_netsuite_id', ''),
        vendor_name = nullif(btrim(p->>'vendor_name'), ''), reason = btrim(p->>'reason'), changes = p->'changes',
        patch = p->'patch', replace_lists = v_lists,
        total_before_cents = (p->>'total_before_cents')::bigint, total_expected_cents = (p->>'total_expected_cents')::bigint,
        total_after_cents = NULL, status = 'sending', error = NULL, own_copy = NULL, own_copy_version = NULL,
        created_by = coalesce(nullif(p->>'by', '')::uuid, created_by), sent_at = now(), finished_at = NULL
    WHERE id = v_id;
  ELSE
    INSERT INTO public.bill_fixes (
      id, bill_netsuite_id, bill_number, vendor_netsuite_id, vendor_name, reason, changes, patch, replace_lists,
      total_before_cents, total_expected_cents, created_by
    ) VALUES (
      v_id, v_bill, nullif(btrim(p->>'bill_number'), ''), nullif(p->>'vendor_netsuite_id', ''),
      nullif(btrim(p->>'vendor_name'), ''), btrim(p->>'reason'), p->'changes', p->'patch', v_lists,
      (p->>'total_before_cents')::bigint, (p->>'total_expected_cents')::bigint, nullif(p->>'by', '')::uuid
    );
  END IF;
  RETURN jsonb_build_object('claimed', true);
END;
$$;

-- Finishes a send. p: { id, status ('fixed', 'refused' or 'unsure'), error?, total_after_cents?, own_copy?,
-- own_copy_version? }. Only a send still sending finishes. Returns { finished }.
CREATE OR REPLACE FUNCTION public.bill_fix_finish(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(p->>'status', '') NOT IN ('fixed', 'refused', 'unsure') THEN
    RAISE EXCEPTION 'bill fixes: a send finishes fixed, refused or unsure, not %', coalesce(p->>'status', '(nothing)');
  END IF;
  UPDATE public.bill_fixes
  SET status = p->>'status', error = left(nullif(btrim(p->>'error'), ''), 2000),
      total_after_cents = (p->>'total_after_cents')::bigint, own_copy = nullif(p->>'own_copy', ''),
      own_copy_version = (p->>'own_copy_version')::integer, finished_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('finished', FOUND);
END;
$$;

-- ── Books' own copy follows ────────────────────────────────────────────────

ALTER TABLE gl_own_bills ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE gl_own_bills ADD COLUMN IF NOT EXISTS fixed_at TIMESTAMPTZ;
ALTER TABLE gl_own_bills ADD COLUMN IF NOT EXISTS fixed_by UUID;

CREATE TABLE IF NOT EXISTS gl_own_bill_versions (
  netsuite_id TEXT NOT NULL REFERENCES gl_own_bills(netsuite_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- The copy as it was, its lines with it.
  copy JSONB NOT NULL CHECK (jsonb_typeof(copy) = 'object'),
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_by UUID,
  -- The fix that replaced it.
  fix_id UUID REFERENCES bill_fixes(id) ON DELETE SET NULL,
  PRIMARY KEY (netsuite_id, version)
);

-- Makes the next version of FleetSuite's own copy of a bill it fixed, keeping the one before. p:
--   { netsuite_id, version (the copy's version the fix was worked out from), fix_id?, fixed_by?, number?, bill_date,
--     total, lines: [{ line_no, account_netsuite_id?, item_netsuite_id?, item_number?, description?, quantity?, rate?,
--                      amount, po_line_id? }] }
-- Every line has its amount, and they add up to its total. The number is the vendor's number for the bill, NetSuite's
-- Reference No. and its number both; none keeps the one the copy has. Answers { saved: true, version, lines }, or
-- { saved: false, reason } with 'none' (no copy) or 'changed' (the copy isn't the version the fix read).
CREATE OR REPLACE FUNCTION public.gl_own_bill_fix(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id TEXT := p->>'netsuite_id';
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_row public.gl_own_bills;
  v_total NUMERIC;
  v_number TEXT := nullif(btrim(p->>'number'), '');
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: a fixed own bill needs NetSuite''s id for the bill';
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: lines must be a list';
  END IF;
  SELECT * INTO v_row FROM public.gl_own_bills WHERE netsuite_id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('saved', false, 'reason', 'none');
  END IF;
  IF v_row.version IS DISTINCT FROM (p->>'version')::integer THEN
    RETURN jsonb_build_object('saved', false, 'reason', 'changed', 'version', v_row.version);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) AS x(v) WHERE nullif(x.v->>'amount', '') IS NULL) THEN
    RAISE EXCEPTION 'gl: every line of fixed own bill % needs its amount', v_id;
  END IF;
  SELECT coalesce(sum((x.v->>'amount')::numeric), 0) INTO v_total FROM jsonb_array_elements(v_lines) AS x(v);
  IF v_total IS DISTINCT FROM (p->>'total')::numeric THEN
    RAISE EXCEPTION 'gl: fixed own bill %''s lines don''t add up to its total', v_id;
  END IF;

  INSERT INTO public.gl_own_bill_versions (netsuite_id, version, copy, replaced_by, fix_id)
  VALUES (
    v_id, v_row.version,
    to_jsonb(v_row) || jsonb_build_object('lines', (
      SELECT coalesce(jsonb_agg(to_jsonb(l) - 'bill_id' ORDER BY l.line_no), '[]'::jsonb)
      FROM public.gl_own_bill_lines l WHERE l.bill_id = v_id
    )),
    nullif(p->>'fixed_by', '')::uuid, nullif(p->>'fix_id', '')::uuid
  );

  -- FleetSuite now knows every line of the bill and what each comes to.
  UPDATE public.gl_own_bills
  SET netsuite_number = coalesce(v_number, netsuite_number), reference_no = coalesce(v_number, reference_no),
      bill_date = (p->>'bill_date')::date, unknowns = '{}',
      version = v_row.version + 1, fixed_at = now(), fixed_by = nullif(p->>'fixed_by', '')::uuid
  WHERE netsuite_id = v_id;

  DELETE FROM public.gl_own_bill_lines WHERE bill_id = v_id;
  INSERT INTO public.gl_own_bill_lines (
    bill_id, line_no, account_netsuite_id, item_netsuite_id, item_number, description, quantity, rate, amount, po_line_id
  )
  SELECT v_id, x.line_no, nullif(x.account_netsuite_id, ''), nullif(x.item_netsuite_id, ''), nullif(x.item_number, ''),
         nullif(x.description, ''), x.quantity, x.rate, x.amount, nullif(x.po_line_id, '')
  FROM jsonb_to_recordset(v_lines) AS x(
    line_no INTEGER, account_netsuite_id TEXT, item_netsuite_id TEXT, item_number TEXT, description TEXT,
    quantity NUMERIC, rate NUMERIC, amount NUMERIC, po_line_id TEXT
  );

  RETURN jsonb_build_object('saved', true, 'version', v_row.version + 1, 'lines', jsonb_array_length(v_lines));
END;
$$;

-- Migration 436's gl_own_bill_pairs, with each copy's version and when FleetSuite last fixed it, so the check
-- says a fixed copy's lines are the bill's as fixed.
CREATE OR REPLACE FUNCTION public.gl_own_bill_pairs(p_from DATE, p_to DATE, p_netsuite_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH own AS (
    SELECT o.*, c.code AS company
    FROM public.gl_own_bills o
    JOIN public.gl_companies c ON c.id = o.company_id
    WHERE CASE WHEN p_netsuite_id IS NOT NULL THEN o.netsuite_id = p_netsuite_id
               ELSE o.bill_date BETWEEN p_from AND p_to END
  ),
  twin AS (
    SELECT b.*
    FROM public.gl_netsuite_bills b
    WHERE b.netsuite_id IN (SELECT netsuite_id FROM own)
  )
  SELECT jsonb_build_object(
    'bills', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'netsuite_id', o.netsuite_id,
          'number', o.netsuite_number,
          'company', o.company,
          'made_from', o.made_from,
          'made_from_id', o.made_from_id,
          'vendor_id', o.vendor_netsuite_id,
          'vendor_name', o.vendor_name,
          'reference_no', o.reference_no,
          'date', to_char(o.bill_date, 'YYYY-MM-DD'),
          'po_id', o.po_netsuite_id,
          'po_number', o.po_number,
          'location_id', o.location_netsuite_id,
          'invoice_total', o.invoice_total::text,
          'unknowns', to_jsonb(o.unknowns),
          'made_at', o.made_at,
          'made_by', o.made_by,
          'version', o.version,
          'fixed_at', o.fixed_at,
          'lines', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'line_no', l.line_no,
              'account_id', l.account_netsuite_id,
              'item_id', l.item_netsuite_id,
              'item_number', l.item_number,
              'description', l.description,
              'quantity', l.quantity::text,
              'rate', l.rate::text,
              'amount', l.amount::text,
              'po_line_id', l.po_line_id
            ) ORDER BY l.line_no), '[]'::jsonb)
            FROM public.gl_own_bill_lines l
            WHERE l.bill_id = o.netsuite_id
          )
        ),
        'netsuite', (
          SELECT jsonb_build_object(
            'number', t.tranid,
            'type', t.tran_type,
            'date', to_char(t.trandate, 'YYYY-MM-DD'),
            'vendor_id', t.vendor_netsuite_id,
            'vendor_name', t.vendor_name,
            'total', t.total::text,
            'status', t.status_label,
            'voided', t.voided,
            'gone', t.gone_at IS NOT NULL,
            'lines', t.lines,
            'links', t.links,
            'companies', (
              SELECT coalesce(jsonb_agg(DISTINCT gc.code ORDER BY gc.code), '[]'::jsonb)
              FROM public.gl_netsuite_lines gl
              JOIN public.gl_companies gc ON gc.id = gl.company_id
              WHERE gl.transaction_id = t.netsuite_id
            )
          )
          FROM twin t
          WHERE t.netsuite_id = o.netsuite_id
        )
      ) ORDER BY o.bill_date DESC, o.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM own o
    ),
    'accounts', (
      SELECT coalesce(jsonb_object_agg(a.netsuite_account_id, jsonb_build_object('number', a.number, 'name', a.name)), '{}'::jsonb)
      FROM public.gl_accounts a
      WHERE a.netsuite_account_id IN (
        SELECT l.account_netsuite_id FROM public.gl_own_bill_lines l JOIN own o ON o.netsuite_id = l.bill_id
        UNION
        SELECT x.line->>'account' FROM twin t CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.lines, '[]'::jsonb)) AS x(line)
        WHERE jsonb_typeof(x.line) = 'object'
      )
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(i.netsuite_id, jsonb_build_object(
        'number', i.name, 'type', i.details->>'item_type', 'display_name', i.details->>'display_name'
      )), '{}'::jsonb)
      FROM public.gl_netsuite_lists i
      WHERE i.kind = 'item' AND i.netsuite_id IN (
        SELECT l.item_netsuite_id FROM public.gl_own_bill_lines l JOIN own o ON o.netsuite_id = l.bill_id
        UNION
        SELECT x.line->>'item' FROM twin t CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.lines, '[]'::jsonb)) AS x(line)
        WHERE jsonb_typeof(x.line) = 'object'
      )
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bill_fixes', 'gl_own_bill_versions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.bill_fix_claim(jsonb)', 'public.bill_fix_finish(jsonb)', 'public.gl_own_bill_fix(jsonb)',
    'public.gl_own_bill_pairs(date, date, text)'
  ] LOOP
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

COMMENT ON TABLE bill_fixes IS 'Migration 472: one row per press of Fix bill on the Fix screen (src/lib/bill-fix.ts, /api/purchasing/bill-fix): what changes in words, what NetSuite was sent, whether it went in, and what became of Books'' own copy of the bill. One fix of a bill is sent at a time. Moved only by its functions. Service-role write and read.';
COMMENT ON TABLE gl_own_bill_versions IS 'Migration 472: each version of FleetSuite''s own copy of a bill that a fix replaced, as it was, its lines with it. Written only by gl_own_bill_fix. Service-role write and read.';
COMMENT ON COLUMN gl_own_bills.version IS 'Migration 472: 1 as the copy was made; each fix FleetSuite makes to the bill makes the next, keeping the one before in gl_own_bill_versions.';
COMMENT ON FUNCTION public.bill_fix_claim(jsonb) IS 'Migration 472: takes the claim for a press of Fix bill, one fix of a bill at a time, or says what became of it. Service role only.';
COMMENT ON FUNCTION public.bill_fix_finish(jsonb) IS 'Migration 472: finishes a send of a fix: fixed, refused or unsure. Service role only.';
COMMENT ON FUNCTION public.gl_own_bill_fix(jsonb) IS 'Migration 472: makes the next version of FleetSuite''s own copy of a bill it fixed, keeping the one before; refuses one whose lines don''t add up. Service role only.';
COMMENT ON FUNCTION public.gl_own_bill_pairs(date, date, text) IS 'Migration 435/436/472: Books'' own bills made on some days, or one, each next to NetSuite''s bill as the copy of its bills has it, with the companies the copy of its general ledger books it to, who made the copy, and its version and when FleetSuite last fixed it, for the Own bills page and the daily check. Service role only.';
