-- Migration 494: inventory adjustments approved before they're posted (Books
-- part 63), switched off.
--
-- The NetSuite Exit Checklist's "Inventory moves and value", first slice
-- (src/lib/inventory-adjust-approvals.ts, /api/inventory/adjust and
-- /api/inventory/adjust/approvals, page /admin/inventory/approvals,
-- docs/books.md "Adjustments approved before they're posted"; the plan has
-- inventory adjustments approved from the second quarter of 2027). Inventory
-- Adjust (migration 454, src/lib/inventory-adjust.ts) posts a NetSuite
-- Inventory Adjustment at once. Once approving adjustments is switched on, it
-- asks for approval instead:
--
--   * books_switches gets 'adjustment_approvals', off;
--   * inventory_adjustment_asks, one row per adjustment asked for: the item
--     at its location, how it was entered (a change, or the count on the
--     shelf), NetSuite's count when it was asked and the change that makes,
--     the reason and note, and where it is: waiting for approval, being
--     posted, posted without FleetSuite hearing back whether NetSuite took it,
--     made, turned down with why, or withdrawn by whoever asked.
--
-- The change is worked out when it's asked, against NetSuite's live count
-- then, and posted as that change once a super admin who didn't ask approves
-- it, so a shelf count stays what the count found even if stock moves before
-- it's approved. One adjustment waits per item and location at a time, so two
-- counts of the same shelf can't both be posted. Nobody is alerted (Craig,
-- 2026-10-30: no alerts for adjustments).
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

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
                   'customer_payments', 'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals'));

INSERT INTO books_switches (piece) VALUES ('adjustment_approvals') ON CONFLICT (piece) DO NOTHING;

-- ── The adjustments asked for ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inventory_adjustment_asks (
  -- Made by the route when Ask for approval is pressed, so a press sent twice is saved once.
  id UUID PRIMARY KEY,
  part_id UUID REFERENCES netsuite_parts(id) ON DELETE SET NULL,
  netsuite_item_id TEXT NOT NULL CHECK (netsuite_item_id ~ '^[0-9]+$'),
  item_number TEXT NOT NULL CHECK (btrim(item_number) <> '' AND length(item_number) <= 300),
  -- NetSuite's location the adjustment is at (O'Fallon).
  location_id TEXT NOT NULL CHECK (location_id ~ '^[0-9]+$'),
  -- 'delta' = a number added or taken away; 'count' = the count on the shelf.
  mode TEXT NOT NULL CHECK (mode IN ('delta', 'count')),
  entered_qty NUMERIC NOT NULL CHECK (entered_qty = round(entered_qty)),
  -- NetSuite's live count at the location when it was asked, and the change that makes.
  on_hand_then NUMERIC NOT NULL,
  change NUMERIC NOT NULL CHECK (change <> 0 AND change = round(change)),
  reason TEXT NOT NULL CHECK (reason IN ('Count correction', 'Damaged', 'Used in shop', 'Found', 'Other')),
  note TEXT CHECK (length(note) <= 500),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sending', 'unsure', 'made', 'turned_down', 'withdrawn')),
  asked_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  asked_by_name TEXT CHECK (length(asked_by_name) <= 200),
  asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The press of Approve that's posting it, posted it, or didn't hear back.
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  sent_by_name TEXT CHECK (length(sent_by_name) <= 200),
  sent_at TIMESTAMPTZ,
  -- Who made it, turned it down or withdrew it, and when.
  decided_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  decided_by_name TEXT CHECK (length(decided_by_name) <= 200),
  decided_at TIMESTAMPTZ,
  -- Why it was turned down, which whoever asked sees.
  why TEXT CHECK (length(why) <= 300),
  netsuite_adjustment_number TEXT CHECK (length(netsuite_adjustment_number) <= 60),
  -- Why NetSuite didn't post it, or why FleetSuite can't tell, the last time it was approved.
  error TEXT CHECK (length(error) <= 2000),
  -- Posted, but FleetSuite couldn't keep it in the Adjust history.
  warning TEXT CHECK (length(warning) <= 2000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (mode <> 'delta' OR change = entered_qty),
  CHECK (mode <> 'count' OR (entered_qty >= 0 AND change = entered_qty - on_hand_then)),
  CHECK (on_hand_then + change >= 0),
  CHECK (status NOT IN ('sending', 'unsure', 'made') OR sent_at IS NOT NULL),
  CHECK (status NOT IN ('made', 'turned_down', 'withdrawn') OR decided_at IS NOT NULL),
  CHECK (status <> 'turned_down' OR btrim(coalesce(why, '')) <> '')
);

-- One adjustment waits per item and location at a time.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_adjustment_asks_one_open
  ON inventory_adjustment_asks (netsuite_item_id, location_id) WHERE status IN ('waiting', 'sending', 'unsure');
CREATE INDEX IF NOT EXISTS inventory_adjustment_asks_asked_idx ON inventory_adjustment_asks (asked_at DESC, id);
CREATE INDEX IF NOT EXISTS inventory_adjustment_asks_item_idx ON inventory_adjustment_asks (netsuite_item_id, asked_at DESC, id);

-- Saves an adjustment asked for. p:
--   { id, by, by_name?, part_id?, netsuite_item_id, item_number, location_id, mode, entered_qty, on_hand_then, reason,
--     note? }
-- The change is worked out here: the number entered for 'delta', the count less NetSuite's count then for 'count'.
-- Answers { state, ask } with:
--   'asked'    saved, waiting for approval;
--   'same'     this press was saved already;
--   'waiting'  the item at this location has one waiting, being posted or not known already (ask: that one), and
--              nothing is saved.
CREATE OR REPLACE FUNCTION public.inventory_adjustment_ask(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_mode TEXT := p->>'mode';
  v_entered NUMERIC := (p->>'entered_qty')::numeric;
  v_then NUMERIC := (p->>'on_hand_then')::numeric;
  v_row public.inventory_adjustment_asks;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'adjustments: an adjustment asked for needs who asked';
  END IF;
  SELECT * INTO v_row FROM public.inventory_adjustment_asks WHERE id = v_id;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'same', 'ask', to_jsonb(v_row));
  END IF;
  SELECT * INTO v_row FROM public.inventory_adjustment_asks
  WHERE netsuite_item_id = p->>'netsuite_item_id' AND location_id = p->>'location_id' AND status IN ('waiting', 'sending', 'unsure');
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'waiting', 'ask', to_jsonb(v_row));
  END IF;

  BEGIN
    INSERT INTO public.inventory_adjustment_asks (
      id, part_id, netsuite_item_id, item_number, location_id, mode, entered_qty, on_hand_then, change, reason, note,
      asked_by, asked_by_name
    ) VALUES (
      v_id, nullif(p->>'part_id', '')::uuid, p->>'netsuite_item_id', btrim(coalesce(p->>'item_number', '')), p->>'location_id', v_mode,
      v_entered, v_then, CASE WHEN v_mode = 'count' THEN v_entered - v_then ELSE v_entered END, p->>'reason',
      nullif(btrim(coalesce(p->>'note', '')), ''), (p->>'by')::uuid, nullif(btrim(coalesce(p->>'by_name', '')), '')
    )
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- Another press got in first: this same one, or another for the same shelf.
    SELECT * INTO v_row FROM public.inventory_adjustment_asks WHERE id = v_id;
    IF FOUND THEN
      RETURN jsonb_build_object('state', 'same', 'ask', to_jsonb(v_row));
    END IF;
    SELECT * INTO v_row FROM public.inventory_adjustment_asks
    WHERE netsuite_item_id = p->>'netsuite_item_id' AND location_id = p->>'location_id' AND status IN ('waiting', 'sending', 'unsure');
    RETURN jsonb_build_object('state', 'waiting', 'ask', to_jsonb(v_row));
  END;
  RETURN jsonb_build_object('state', 'asked', 'ask', to_jsonb(v_row));
END;
$$;

-- Takes the claim for a press of Approve, to post it in NetSuite. p: { id, by, by_name? }. Answers { state, ask } with:
--   'claimed'  this press now holds it;
--   'own'      whoever pressed asked for it, and a super admin who didn't approves it; nothing changes;
--   'gone'     there's no such adjustment (no ask);
--   otherwise its status, when it isn't waiting: 'sending', 'unsure', 'made', 'turned_down' or 'withdrawn'.
CREATE OR REPLACE FUNCTION public.inventory_adjustment_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.inventory_adjustment_asks;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'adjustments: an approval needs who approved';
  END IF;
  SELECT * INTO v_row FROM public.inventory_adjustment_asks WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'waiting' THEN
    RETURN jsonb_build_object('state', v_row.status, 'ask', to_jsonb(v_row));
  END IF;
  IF v_row.asked_by = (p->>'by')::uuid THEN
    RETURN jsonb_build_object('state', 'own', 'ask', to_jsonb(v_row));
  END IF;
  UPDATE public.inventory_adjustment_asks
  SET status = 'sending', sent_by = (p->>'by')::uuid, sent_by_name = nullif(btrim(coalesce(p->>'by_name', '')), ''), sent_at = now(),
      error = NULL, updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'claimed', 'ask', to_jsonb(v_row));
END;
$$;

-- Lets go of a press NetSuite didn't post it for, keeping why, so it waits to be approved again. p: { id, error }.
-- Returns { let_go }.
CREATE OR REPLACE FUNCTION public.inventory_adjustment_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.inventory_adjustment_asks
  SET status = 'waiting', sent_by = NULL, sent_by_name = NULL, sent_at = NULL,
      error = left(coalesce(nullif(btrim(p->>'error'), ''), 'Not posted'), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('let_go', FOUND);
END;
$$;

-- Keeps that a press didn't hear back whether NetSuite posted it, with why. p: { id, error }. Returns { unsure }.
CREATE OR REPLACE FUNCTION public.inventory_adjustment_unsure(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.inventory_adjustment_asks
  SET status = 'unsure', error = left(coalesce(nullif(btrim(p->>'error'), ''), 'No answer from NetSuite'), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('unsure', FOUND);
END;
$$;

-- Keeps the adjustment NetSuite posted for a press. p: { id, netsuite_number?, warning? }. Returns { made } — false when
-- it isn't being posted (made already, or let go).
CREATE OR REPLACE FUNCTION public.inventory_adjustment_made(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.inventory_adjustment_asks
  SET status = 'made', netsuite_adjustment_number = left(nullif(btrim(coalesce(p->>'netsuite_number', '')), ''), 60),
      decided_by = sent_by, decided_by_name = sent_by_name, decided_at = now(),
      error = NULL, warning = left(nullif(btrim(coalesce(p->>'warning', '')), ''), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('made', FOUND);
END;
$$;

-- Settles one FleetSuite couldn't tell about: posted without hearing back from NetSuite, or being posted for more than
-- five minutes, longer than a press takes. p: { id, by, by_name?, made, netsuite_number? }: made keeps it as posted in
-- NetSuite, with its number when given; not made puts it back to wait for approval. Answers { state, ask, settled }
-- with 'made' or 'waiting' and settled true when this settled it; otherwise 'not_yet' while a press may still be
-- posting it, 'gone', or its status when there's nothing to settle.
CREATE OR REPLACE FUNCTION public.inventory_adjustment_settle(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.inventory_adjustment_asks;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'adjustments: settling one needs who settled it';
  END IF;
  IF jsonb_typeof(p->'made') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'adjustments: settling one says whether NetSuite has it';
  END IF;
  SELECT * INTO v_row FROM public.inventory_adjustment_asks WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status = 'sending' AND v_row.sent_at > now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('state', 'not_yet', 'ask', to_jsonb(v_row));
  END IF;
  IF v_row.status NOT IN ('sending', 'unsure') THEN
    RETURN jsonb_build_object('state', v_row.status, 'ask', to_jsonb(v_row));
  END IF;
  IF (p->>'made')::boolean THEN
    UPDATE public.inventory_adjustment_asks
    SET status = 'made', netsuite_adjustment_number = left(nullif(btrim(coalesce(p->>'netsuite_number', '')), ''), 60),
        decided_by = (p->>'by')::uuid, decided_by_name = nullif(btrim(coalesce(p->>'by_name', '')), ''), decided_at = now(),
        error = NULL, updated_at = now()
    WHERE id = v_row.id
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.inventory_adjustment_asks
    SET status = 'waiting', sent_by = NULL, sent_by_name = NULL, sent_at = NULL,
        error = left('Not in NetSuite, said ' || coalesce(nullif(btrim(coalesce(p->>'by_name', '')), ''), 'a super admin'), 2000),
        updated_at = now()
    WHERE id = v_row.id
    RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('state', v_row.status, 'ask', to_jsonb(v_row), 'settled', true);
END;
$$;

-- Turns down an adjustment waiting for approval, for a reason whoever asked sees. p: { id, by, by_name?, why }. Whoever
-- asked withdraws it instead. Answers { state, ask } with 'turned_down', 'own', 'gone', or its status when it isn't
-- waiting.
CREATE OR REPLACE FUNCTION public.inventory_adjustment_turn_down(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_why TEXT := btrim(coalesce(p->>'why', ''));
  v_row public.inventory_adjustment_asks;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'adjustments: turning one down needs who turned it down';
  END IF;
  IF v_why = '' OR length(v_why) > 300 THEN
    RAISE EXCEPTION 'adjustments: turning one down needs why, 300 characters at most';
  END IF;
  SELECT * INTO v_row FROM public.inventory_adjustment_asks WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'waiting' THEN
    RETURN jsonb_build_object('state', v_row.status, 'ask', to_jsonb(v_row));
  END IF;
  IF v_row.asked_by = (p->>'by')::uuid THEN
    RETURN jsonb_build_object('state', 'own', 'ask', to_jsonb(v_row));
  END IF;
  UPDATE public.inventory_adjustment_asks
  SET status = 'turned_down', why = v_why, decided_by = (p->>'by')::uuid, decided_by_name = nullif(btrim(coalesce(p->>'by_name', '')), ''),
      decided_at = now(), updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'turned_down', 'ask', to_jsonb(v_row));
END;
$$;

-- Withdraws an adjustment waiting for approval, by whoever asked for it. p: { id, by, by_name? }. Answers { state, ask }
-- with 'withdrawn', 'not_yours', 'gone', or its status when it isn't waiting.
CREATE OR REPLACE FUNCTION public.inventory_adjustment_withdraw(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.inventory_adjustment_asks;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'adjustments: withdrawing one needs who withdrew it';
  END IF;
  SELECT * INTO v_row FROM public.inventory_adjustment_asks WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'waiting' THEN
    RETURN jsonb_build_object('state', v_row.status, 'ask', to_jsonb(v_row));
  END IF;
  IF v_row.asked_by IS DISTINCT FROM (p->>'by')::uuid THEN
    RETURN jsonb_build_object('state', 'not_yours', 'ask', to_jsonb(v_row));
  END IF;
  UPDATE public.inventory_adjustment_asks
  SET status = 'withdrawn', decided_by = (p->>'by')::uuid, decided_by_name = nullif(btrim(coalesce(p->>'by_name', '')), ''),
      decided_at = now(), updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'withdrawn', 'ask', to_jsonb(v_row));
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE public.inventory_adjustment_asks ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.inventory_adjustment_asks FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.inventory_adjustment_ask(jsonb)', 'public.inventory_adjustment_claim(jsonb)', 'public.inventory_adjustment_let_go(jsonb)',
    'public.inventory_adjustment_unsure(jsonb)', 'public.inventory_adjustment_made(jsonb)', 'public.inventory_adjustment_settle(jsonb)',
    'public.inventory_adjustment_turn_down(jsonb)', 'public.inventory_adjustment_withdraw(jsonb)'
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

COMMENT ON TABLE inventory_adjustment_asks IS 'Migration 494: each inventory adjustment asked for with Adjust once approving adjustments is switched on (books_switches adjustment_approvals): the item at its location, the change worked out against NetSuite''s count when it was asked, the reason and note, and where it is, from waiting for approval to made in NetSuite, turned down or withdrawn (src/lib/inventory-adjust-approvals.ts). One waits per item and location. Moved only by its functions. Service-role write and read.';
COMMENT ON FUNCTION public.inventory_adjustment_ask(jsonb) IS 'Migration 494: saves an adjustment asked for, working out its change, unless the item at that location has one waiting already. Service role only.';
COMMENT ON FUNCTION public.inventory_adjustment_claim(jsonb) IS 'Migration 494: takes the claim for a press of Approve by someone who didn''t ask, to post it in NetSuite. Service role only.';
COMMENT ON FUNCTION public.inventory_adjustment_let_go(jsonb) IS 'Migration 494: puts an adjustment NetSuite didn''t post back to wait for approval, keeping why. Service role only.';
COMMENT ON FUNCTION public.inventory_adjustment_unsure(jsonb) IS 'Migration 494: keeps that a press didn''t hear back whether NetSuite posted the adjustment. Service role only.';
COMMENT ON FUNCTION public.inventory_adjustment_made(jsonb) IS 'Migration 494: keeps the adjustment NetSuite posted for a press, with its number. Service role only.';
COMMENT ON FUNCTION public.inventory_adjustment_settle(jsonb) IS 'Migration 494: settles an adjustment FleetSuite couldn''t tell about, as posted in NetSuite or back to wait for approval. Service role only.';
COMMENT ON FUNCTION public.inventory_adjustment_turn_down(jsonb) IS 'Migration 494: turns down an adjustment waiting for approval, for a reason, by someone who didn''t ask. Service role only.';
COMMENT ON FUNCTION public.inventory_adjustment_withdraw(jsonb) IS 'Migration 494: withdraws an adjustment waiting for approval, by whoever asked. Service role only.';
