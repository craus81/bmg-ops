-- Migration 478: FleetSuite's own books, part 46 — an item's accounts
-- changed in FleetSuite and sent on to NetSuite, switched off until it's
-- turned on.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking; in the first quarter
-- FleetSuite becomes the master for items, with each item's income, cost and
-- inventory accounts; each piece that takes the team out of NetSuite is built
-- switched off, and FleetSuite sends the change on to NetSuite. An item's
-- income account, an inventory item's cost of goods sold and inventory asset
-- accounts, and the expense account of one bought for resale or only bought
-- (src/lib/item-accounts.ts, /api/item-accounts, page /admin/item-accounts;
-- docs/books.md "Item accounts changed in FleetSuite").
--
--   * books_switches takes a ninth piece, item_accounts, off;
--   * detail_changes (migration 473) keeps a press of Save on Item Accounts
--     as it does one on Customer Terms or Vendor Details: record_type
--     'item', and detail_change_claim takes the claim for one, one change of
--     an item at a time.
--
-- Writer and reader: the service role only, as migration 473 left them.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 473 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all nine.
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
                   'bill_fixes', 'customer_vendor_details', 'item_accounts'));

INSERT INTO books_switches (piece) VALUES ('item_accounts') ON CONFLICT (piece) DO NOTHING;

-- ── A change of an item ────────────────────────────────────────────────────

-- The same for the kinds of record a change is of: take whichever check names them and put back one with items.
DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.detail_changes'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%record_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.detail_changes DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE detail_changes ADD CONSTRAINT detail_changes_record_type_check
  CHECK (record_type IN ('customer', 'vendor', 'item'));

-- Takes the claim for a press of Save, as migration 473's does, now of an item too. p:
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
  IF coalesce(v_type, '') NOT IN ('customer', 'vendor', 'item') THEN
    RAISE EXCEPTION 'detail changes: a change is of a customer, a vendor or an item, not %', coalesce(v_type, '(nothing)');
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

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.detail_change_claim(jsonb) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.detail_change_claim(jsonb) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.detail_change_claim(jsonb) TO service_role;
  END IF;
END $$;

COMMENT ON TABLE detail_changes IS 'Migrations 473 and 478: one row per press of Save on Customer Terms, Vendor Details or Item Accounts (src/lib/customer-terms.ts, src/lib/vendor-details.ts, src/lib/item-accounts.ts): what changes in words, what NetSuite was sent (a tax ID only as the four digits it ends with), and whether it went in. One change of a customer, vendor or item is sent at a time. Moved only by its functions. Service-role write and read.';
COMMENT ON FUNCTION public.detail_change_claim(jsonb) IS 'Migrations 473 and 478: takes the claim for a press of Save on Customer Terms, Vendor Details or Item Accounts, one change of a record at a time, or says what became of it. Service role only.';
