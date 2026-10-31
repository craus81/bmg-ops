-- Migration 471: FleetSuite's own books, part 39 — invoices fixed in
-- FleetSuite after they're made and sent on to NetSuite, switched off until
-- January 1, 2027.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking; each piece that takes
-- them out of NetSuite is built switched off, and FleetSuite sends its
-- document on to NetSuite. Fixing an invoice comes sixth: its PO number, memo
-- and VIN, and while nothing on it is paid or credited its date and lines,
-- changed in FleetSuite and in NetSuite (src/lib/invoice-fix.ts,
-- /api/invoices/fix, page /invoices/fix, docs/books.md "Invoices fixed in
-- FleetSuite").
--
--   * books_switches takes a sixth piece, invoice_fixes, off;
--   * invoice_fixes, one row per press of Fix invoice. Its id comes from the
--     page, so a second press of the same form never sends the fix twice, and
--     only one fix of an invoice is sent at a time. It goes sending → fixed,
--     or refused (NetSuite said no, so nothing changed) or unsure (NetSuite
--     didn't answer, so it may have changed). A send that never finished
--     holds the invoice five minutes at most;
--   * gl_own_invoices gains a version: when FleetSuite fixes an invoice it
--     has its own copy of, gl_own_invoice_fix makes the copy's next version
--     from the fix, keeping each version before in gl_own_invoice_versions,
--     and lines_from says 'fixed'. Saving a copy (gl_own_invoice_save) still
--     never changes one.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 470 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all six.
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
  CHECK (piece IN ('credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes'));

INSERT INTO books_switches (piece) VALUES ('invoice_fixes') ON CONFLICT (piece) DO NOTHING;

-- ── The fixes ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoice_fixes (
  -- Made by the page when the screen opens: the same form pressed twice is one fix.
  id UUID PRIMARY KEY,
  invoice_netsuite_id TEXT NOT NULL CHECK (invoice_netsuite_id ~ '^[0-9]+$'),
  invoice_number TEXT,
  customer_netsuite_id TEXT CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_name TEXT,
  reason TEXT NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 300),
  -- What changes, a sentence each, as the screen listed them.
  changes JSONB NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) > 0),
  -- What NetSuite was sent, and whether it made the invoice's lines exactly those (a line taken off).
  patch JSONB NOT NULL CHECK (jsonb_typeof(patch) = 'object'),
  replace_lines BOOLEAN NOT NULL DEFAULT false,
  -- The total before, FleetSuite's working of it after (NetSuite works out the tax), and NetSuite's once it answered.
  total_before_cents BIGINT,
  total_expected_cents BIGINT,
  total_after_cents BIGINT,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'fixed', 'refused', 'unsure')),
  -- NetSuite's reason, or why FleetSuite can't tell.
  error TEXT CHECK (length(error) <= 2000),
  -- What became of Books' own copy of the invoice: 'fixed' (its next version), 'none' (it has none), 'not_saved'.
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
CREATE INDEX IF NOT EXISTS invoice_fixes_invoice_idx ON invoice_fixes (invoice_netsuite_id, created_at DESC, id);
-- One fix of an invoice at a time.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_fixes_one_sending ON invoice_fixes (invoice_netsuite_id) WHERE status = 'sending';

-- Takes the claim for a press of Fix invoice. p:
--   { id, invoice_netsuite_id, invoice_number?, customer_netsuite_id?, customer_name?, reason, changes, patch,
--     replace_lines?, total_before_cents?, total_expected_cents?, by? }
-- Answers { claimed: true }, or { claimed: false, state } with:
--   'fixed'    this press fixed it already;
--   'sending'  this press is sending it now;
--   'busy'     another fix of the invoice is being sent.
-- A press NetSuite refused, or didn't answer, can be pressed again: the route plans it against the invoice as
-- NetSuite has it then. A send started more than five minutes ago that never finished is unsure, and lets go.
CREATE OR REPLACE FUNCTION public.invoice_fix_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_invoice TEXT := p->>'invoice_netsuite_id';
  v_row public.invoice_fixes;
  v_had BOOLEAN;
BEGIN
  IF coalesce(v_invoice, '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invoice fixes: a fix needs NetSuite''s id for the invoice';
  END IF;
  -- One claimer of an invoice at a time, so two presses can't both find it free.
  PERFORM pg_advisory_xact_lock(hashtext('invoice_fix:' || v_invoice));

  UPDATE public.invoice_fixes
  SET status = 'unsure', finished_at = now(),
      error = 'FleetSuite stopped before NetSuite answered, so it can''t tell whether the fix went in. Check the invoice in NetSuite.'
  WHERE invoice_netsuite_id = v_invoice AND status = 'sending' AND sent_at < now() - interval '5 minutes';

  SELECT * INTO v_row FROM public.invoice_fixes WHERE id = v_id FOR UPDATE;
  v_had := FOUND;
  IF v_had THEN
    IF v_row.invoice_netsuite_id <> v_invoice THEN
      RAISE EXCEPTION 'invoice fixes: % is a fix of another invoice', v_id;
    END IF;
    IF v_row.status IN ('fixed', 'sending') THEN
      RETURN jsonb_build_object('claimed', false, 'state', v_row.status);
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoice_fixes WHERE invoice_netsuite_id = v_invoice AND status = 'sending') THEN
    RETURN jsonb_build_object('claimed', false, 'state', 'busy');
  END IF;

  IF v_had THEN
    UPDATE public.invoice_fixes
    SET invoice_number = nullif(btrim(p->>'invoice_number'), ''), customer_netsuite_id = nullif(p->>'customer_netsuite_id', ''),
        customer_name = nullif(btrim(p->>'customer_name'), ''), reason = btrim(p->>'reason'), changes = p->'changes',
        patch = p->'patch', replace_lines = coalesce((p->>'replace_lines')::boolean, false),
        total_before_cents = (p->>'total_before_cents')::bigint, total_expected_cents = (p->>'total_expected_cents')::bigint,
        total_after_cents = NULL, status = 'sending', error = NULL, own_copy = NULL, own_copy_version = NULL,
        created_by = coalesce(nullif(p->>'by', '')::uuid, created_by), sent_at = now(), finished_at = NULL
    WHERE id = v_id;
  ELSE
    INSERT INTO public.invoice_fixes (
      id, invoice_netsuite_id, invoice_number, customer_netsuite_id, customer_name, reason, changes, patch, replace_lines,
      total_before_cents, total_expected_cents, created_by
    ) VALUES (
      v_id, v_invoice, nullif(btrim(p->>'invoice_number'), ''), nullif(p->>'customer_netsuite_id', ''),
      nullif(btrim(p->>'customer_name'), ''), btrim(p->>'reason'), p->'changes', p->'patch',
      coalesce((p->>'replace_lines')::boolean, false), (p->>'total_before_cents')::bigint,
      (p->>'total_expected_cents')::bigint, nullif(p->>'by', '')::uuid
    );
  END IF;
  RETURN jsonb_build_object('claimed', true);
END;
$$;

-- Finishes a send. p: { id, status ('fixed', 'refused' or 'unsure'), error?, total_after_cents?, own_copy?,
-- own_copy_version? }. Only a send still sending finishes. Returns { finished }.
CREATE OR REPLACE FUNCTION public.invoice_fix_finish(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(p->>'status', '') NOT IN ('fixed', 'refused', 'unsure') THEN
    RAISE EXCEPTION 'invoice fixes: a send finishes fixed, refused or unsure, not %', coalesce(p->>'status', '(nothing)');
  END IF;
  UPDATE public.invoice_fixes
  SET status = p->>'status', error = left(nullif(btrim(p->>'error'), ''), 2000),
      total_after_cents = (p->>'total_after_cents')::bigint, own_copy = nullif(p->>'own_copy', ''),
      own_copy_version = (p->>'own_copy_version')::integer, finished_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('finished', FOUND);
END;
$$;

-- ── Books' own copy follows ────────────────────────────────────────────────

ALTER TABLE gl_own_invoices ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE gl_own_invoices ADD COLUMN IF NOT EXISTS fixed_at TIMESTAMPTZ;
ALTER TABLE gl_own_invoices ADD COLUMN IF NOT EXISTS fixed_by UUID;

ALTER TABLE gl_own_invoices DROP CONSTRAINT IF EXISTS gl_own_invoices_lines_from_check;
ALTER TABLE gl_own_invoices ADD CONSTRAINT gl_own_invoices_lines_from_check
  CHECK (lines_from IN ('sent', 'sales_order_copy', 'fixed'));

CREATE TABLE IF NOT EXISTS gl_own_invoice_versions (
  netsuite_id TEXT NOT NULL REFERENCES gl_own_invoices(netsuite_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- The copy as it was, its lines with it.
  copy JSONB NOT NULL CHECK (jsonb_typeof(copy) = 'object'),
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_by UUID,
  -- The fix that replaced it.
  fix_id UUID REFERENCES invoice_fixes(id) ON DELETE SET NULL,
  PRIMARY KEY (netsuite_id, version)
);

-- Makes the next version of FleetSuite's own copy of an invoice it fixed, keeping the one before. p:
--   { netsuite_id, version (the copy's version the fix was worked out from), fix_id?, fixed_by?, invoice_date,
--     due_date?, po_number?, memo?, vin?, subtotal, tax, total, unknowns?,
--     lines: [{ line_no, item_netsuite_id?, item_number?, description?, quantity?, rate?, amount, priced?, taxable,
--               tax, sales_order_line_id? }] }
-- Its lines must add up to its subtotal and tax, and those to its total. Answers { saved: true, version, lines },
-- or { saved: false, reason } with 'none' (no copy) or 'changed' (the copy isn't the version the fix read).
CREATE OR REPLACE FUNCTION public.gl_own_invoice_fix(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id TEXT := p->>'netsuite_id';
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_row public.gl_own_invoices;
  v_subtotal NUMERIC;
  v_tax NUMERIC;
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: a fixed own invoice needs NetSuite''s id for the invoice';
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: lines must be a list';
  END IF;
  SELECT * INTO v_row FROM public.gl_own_invoices WHERE netsuite_id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('saved', false, 'reason', 'none');
  END IF;
  IF v_row.version IS DISTINCT FROM (p->>'version')::integer THEN
    RETURN jsonb_build_object('saved', false, 'reason', 'changed', 'version', v_row.version);
  END IF;
  SELECT coalesce(sum((x.v->>'amount')::numeric), 0), coalesce(sum((x.v->>'tax')::numeric), 0)
  INTO v_subtotal, v_tax
  FROM jsonb_array_elements(v_lines) AS x(v);
  IF v_subtotal IS DISTINCT FROM (p->>'subtotal')::numeric OR v_tax IS DISTINCT FROM (p->>'tax')::numeric
     OR (p->>'total')::numeric IS DISTINCT FROM v_subtotal + v_tax THEN
    RAISE EXCEPTION 'gl: fixed own invoice %''s lines don''t add up to its subtotal, tax and total', v_id;
  END IF;

  INSERT INTO public.gl_own_invoice_versions (netsuite_id, version, copy, replaced_by, fix_id)
  VALUES (
    v_id, v_row.version,
    to_jsonb(v_row) || jsonb_build_object('lines', (
      SELECT coalesce(jsonb_agg(to_jsonb(l) - 'invoice_id' ORDER BY l.line_no), '[]'::jsonb)
      FROM public.gl_own_invoice_lines l WHERE l.invoice_id = v_id
    )),
    nullif(p->>'fixed_by', '')::uuid, nullif(p->>'fix_id', '')::uuid
  );

  UPDATE public.gl_own_invoices
  SET invoice_date = (p->>'invoice_date')::date, due_date = (p->>'due_date')::date,
      po_number = nullif(btrim(p->>'po_number'), ''), memo = nullif(btrim(p->>'memo'), ''), vin = nullif(btrim(p->>'vin'), ''),
      subtotal = v_subtotal, tax = v_tax, total = v_subtotal + v_tax, lines_from = 'fixed',
      unknowns = coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'unknowns', '[]'::jsonb))), '{}'),
      version = v_row.version + 1, fixed_at = now(), fixed_by = nullif(p->>'fixed_by', '')::uuid
  WHERE netsuite_id = v_id;

  DELETE FROM public.gl_own_invoice_lines WHERE invoice_id = v_id;
  INSERT INTO public.gl_own_invoice_lines (
    invoice_id, line_no, item_netsuite_id, item_number, description, quantity, rate, amount, priced, taxable, tax,
    sales_order_line_id
  )
  SELECT v_id, x.line_no, nullif(x.item_netsuite_id, ''), nullif(x.item_number, ''), nullif(x.description, ''),
         x.quantity, x.rate, x.amount, coalesce(x.priced, true), x.taxable, x.tax, nullif(x.sales_order_line_id, '')
  FROM jsonb_to_recordset(v_lines) AS x(
    line_no INTEGER, item_netsuite_id TEXT, item_number TEXT, description TEXT, quantity NUMERIC, rate NUMERIC,
    amount NUMERIC, priced BOOLEAN, taxable BOOLEAN, tax NUMERIC, sales_order_line_id TEXT
  );

  RETURN jsonb_build_object('saved', true, 'version', v_row.version + 1, 'lines', jsonb_array_length(v_lines));
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_fixes', 'gl_own_invoice_versions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.invoice_fix_claim(jsonb)', 'public.invoice_fix_finish(jsonb)', 'public.gl_own_invoice_fix(jsonb)'] LOOP
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

COMMENT ON TABLE invoice_fixes IS 'Migration 471: one row per press of Fix invoice on the Fix screen (src/lib/invoice-fix.ts, /api/invoices/fix): what changes in words, what NetSuite was sent, whether it went in, and what became of Books'' own copy of the invoice. One fix of an invoice is sent at a time. Moved only by its functions. Service-role write and read.';
COMMENT ON TABLE gl_own_invoice_versions IS 'Migration 471: each version of FleetSuite''s own copy of an invoice that a fix replaced, as it was, its lines with it. Written only by gl_own_invoice_fix. Service-role write and read.';
COMMENT ON COLUMN gl_own_invoices.version IS 'Migration 471: 1 as the copy was made; each fix FleetSuite makes to the invoice makes the next, keeping the one before in gl_own_invoice_versions.';
COMMENT ON FUNCTION public.invoice_fix_claim(jsonb) IS 'Migration 471: takes the claim for a press of Fix invoice, one fix of an invoice at a time, or says what became of it. Service role only.';
COMMENT ON FUNCTION public.invoice_fix_finish(jsonb) IS 'Migration 471: finishes a send of a fix: fixed, refused or unsure. Service role only.';
COMMENT ON FUNCTION public.gl_own_invoice_fix(jsonb) IS 'Migration 471: makes the next version of FleetSuite''s own copy of an invoice it fixed, keeping the one before; refuses one whose lines don''t add up. Service role only.';
