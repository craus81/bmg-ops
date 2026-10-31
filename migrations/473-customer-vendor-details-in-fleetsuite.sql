-- Migration 473: FleetSuite's own books, part 41 — a customer's terms and
-- credit limit, and a vendor's details, changed in FleetSuite and sent on
-- to NetSuite, switched off until January 1, 2027.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking; each piece that takes
-- them out of NetSuite is built switched off, and FleetSuite sends the change
-- on to NetSuite. Customer and vendor details come eighth: a customer's terms
-- and credit limit (src/lib/customer-terms.ts, /api/customer-terms, page
-- /admin/customer-terms), and a vendor's email, phone, terms, addresses and
-- 1099 details (src/lib/vendor-details.ts, /api/vendor-details, page
-- /admin/vendor-details); docs/books.md "Customer and vendor details changed
-- in FleetSuite".
--
--   * books_switches takes an eighth piece, customer_vendor_details, off;
--   * detail_changes, one row per press of Save on either screen, as
--     bill_fixes is for bills (migration 472). Its id comes from the page,
--     so a second press of the same form never sends the change twice, and
--     only one change of a customer or vendor is sent at a time. It goes
--     sending → changed, or refused (NetSuite said no, so nothing changed)
--     or unsure (NetSuite didn't answer, so it may have changed). A send
--     that never finished holds the record five minutes at most.
--
-- A vendor's tax ID is never kept in FleetSuite: what NetSuite was sent is
-- kept with the tax ID as the four digits it ends with, and a row that holds
-- more of it is refused.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 472 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all eight.
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
                   'bill_fixes', 'customer_vendor_details'));

INSERT INTO books_switches (piece) VALUES ('customer_vendor_details') ON CONFLICT (piece) DO NOTHING;

-- ── The changes ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS detail_changes (
  -- Made by the page when the screen opens: the same form pressed twice is one change.
  id UUID PRIMARY KEY,
  record_type TEXT NOT NULL CHECK (record_type IN ('customer', 'vendor')),
  netsuite_id TEXT NOT NULL CHECK (netsuite_id ~ '^[0-9]+$'),
  -- The customer's or vendor's name, before the change.
  name TEXT,
  reason TEXT NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 300),
  -- What changes, a sentence each, as the screen listed them.
  changes JSONB NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) > 0),
  -- What NetSuite was sent, a tax ID in it only as the four digits it ends with.
  patch JSONB NOT NULL CHECK (jsonb_typeof(patch) = 'object'),
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'changed', 'refused', 'unsure')),
  -- NetSuite's reason, or why FleetSuite can't tell.
  error TEXT CHECK (length(error) <= 2000),
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CHECK ((status = 'sending') = (finished_at IS NULL)),
  -- A tax ID is never kept whole.
  CONSTRAINT detail_changes_no_tax_id CHECK (length(regexp_replace(coalesce(patch->>'taxIdNum', ''), '[^0-9]', '', 'g')) <= 4)
);
CREATE INDEX IF NOT EXISTS detail_changes_record_idx ON detail_changes (record_type, netsuite_id, created_at DESC, id);
-- One change of a customer or vendor at a time.
CREATE UNIQUE INDEX IF NOT EXISTS detail_changes_one_sending ON detail_changes (record_type, netsuite_id) WHERE status = 'sending';

-- Takes the claim for a press of Save. p:
--   { id, record_type, netsuite_id, name?, reason, changes, patch, by? }
-- Answers { claimed: true }, or { claimed: false, state } with:
--   'changed'  this press changed it already;
--   'sending'  this press is sending it now;
--   'busy'     another change of the record is being sent.
-- A press NetSuite refused, or didn't answer, can be pressed again: the route works it out against the record as
-- NetSuite has it then. A send started more than five minutes ago that never finished is unsure, and lets go.
CREATE OR REPLACE FUNCTION public.detail_change_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_type TEXT := p->>'record_type';
  v_ns TEXT := p->>'netsuite_id';
  v_row public.detail_changes;
  v_had BOOLEAN;
BEGIN
  IF coalesce(v_type, '') NOT IN ('customer', 'vendor') THEN
    RAISE EXCEPTION 'detail changes: a change is of a customer or a vendor, not %', coalesce(v_type, '(nothing)');
  END IF;
  IF coalesce(v_ns, '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'detail changes: a change needs NetSuite''s id for the %', v_type;
  END IF;
  -- One claimer of a record at a time, so two presses can't both find it free.
  PERFORM pg_advisory_xact_lock(hashtext('detail_change:' || v_type || ':' || v_ns));

  UPDATE public.detail_changes
  SET status = 'unsure', finished_at = now(),
      error = 'FleetSuite stopped before NetSuite answered, so it can''t tell whether the change went in. Check it in NetSuite.'
  WHERE record_type = v_type AND netsuite_id = v_ns AND status = 'sending' AND sent_at < now() - interval '5 minutes';

  SELECT * INTO v_row FROM public.detail_changes WHERE id = v_id FOR UPDATE;
  v_had := FOUND;
  IF v_had THEN
    IF v_row.record_type <> v_type OR v_row.netsuite_id <> v_ns THEN
      RAISE EXCEPTION 'detail changes: % is a change of another record', v_id;
    END IF;
    IF v_row.status IN ('changed', 'sending') THEN
      RETURN jsonb_build_object('claimed', false, 'state', v_row.status);
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.detail_changes WHERE record_type = v_type AND netsuite_id = v_ns AND status = 'sending') THEN
    RETURN jsonb_build_object('claimed', false, 'state', 'busy');
  END IF;

  IF v_had THEN
    UPDATE public.detail_changes
    SET name = nullif(btrim(p->>'name'), ''), reason = btrim(p->>'reason'), changes = p->'changes', patch = p->'patch',
        status = 'sending', error = NULL, created_by = coalesce(nullif(p->>'by', '')::uuid, created_by),
        sent_at = now(), finished_at = NULL
    WHERE id = v_id;
  ELSE
    INSERT INTO public.detail_changes (id, record_type, netsuite_id, name, reason, changes, patch, created_by)
    VALUES (v_id, v_type, v_ns, nullif(btrim(p->>'name'), ''), btrim(p->>'reason'), p->'changes', p->'patch',
            nullif(p->>'by', '')::uuid);
  END IF;
  RETURN jsonb_build_object('claimed', true);
END;
$$;

-- Finishes a send. p: { id, status ('changed', 'refused' or 'unsure'), error? }. Only a send still sending finishes.
-- Returns { finished }.
CREATE OR REPLACE FUNCTION public.detail_change_finish(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(p->>'status', '') NOT IN ('changed', 'refused', 'unsure') THEN
    RAISE EXCEPTION 'detail changes: a send finishes changed, refused or unsure, not %', coalesce(p->>'status', '(nothing)');
  END IF;
  UPDATE public.detail_changes
  SET status = p->>'status', error = left(nullif(btrim(p->>'error'), ''), 2000), finished_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('finished', FOUND);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE public.detail_changes ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.detail_changes FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.detail_change_claim(jsonb)', 'public.detail_change_finish(jsonb)'] LOOP
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

COMMENT ON TABLE detail_changes IS 'Migration 473: one row per press of Save on Customer Terms or Vendor Details (src/lib/customer-terms.ts, src/lib/vendor-details.ts): what changes in words, what NetSuite was sent (a tax ID only as the four digits it ends with), and whether it went in. One change of a customer or vendor is sent at a time. Moved only by its functions. Service-role write and read.';
COMMENT ON FUNCTION public.detail_change_claim(jsonb) IS 'Migration 473: takes the claim for a press of Save on Customer Terms or Vendor Details, one change of a record at a time, or says what became of it. Service role only.';
COMMENT ON FUNCTION public.detail_change_finish(jsonb) IS 'Migration 473: finishes a send of a customer''s or vendor''s change: changed, refused or unsure. Service role only.';
