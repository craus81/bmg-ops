-- Migration 499: stock counts (Books part 69), switched off.
--
-- The NetSuite Exit Checklist's "Count screen" (the plan's July to September
-- 2027: count sheets by location, a variance review and one approved
-- adjustment, tried on a partial count in September; src/lib/stock-counts.ts,
-- /api/inventory/counts, pages /admin/inventory/counts, docs/books.md
-- "Counts"). A count lists the items to count at one location, everything
-- NetSuite has there or a part of it, on a sheet to print or to type into on
-- a phone. Once it's counted, its differences from NetSuite are reviewed and
-- asked for as one, and a super admin who didn't ask approves them, which
-- makes one NetSuite Inventory Adjustment with a line for each item that
-- differs:
--
--   * books_switches gets 'stock_counts', off;
--   * stock_counts, one row per count: the location, what's on it, the day
--     its adjustment is dated, and where it is: being counted, asked for,
--     being posted, posted without FleetSuite hearing back whether NetSuite
--     took it, made (posted, or finished with nothing to post) or stopped;
--   * stock_count_lines, one row per item on a count: its place on the
--     sheet, NetSuite's live count there when it went on the count, and once
--     it's counted, the count, NetSuite's live count when it was saved, and
--     who counted it when. An item is on one open count per location at a
--     time, so two counts of a shelf can't both be posted.
--
-- The difference is the count less NetSuite's count when the count was
-- saved, so it stays right when stock moves afterwards, as Adjust's shelf
-- count does (migration 494). An item adjusted with Adjust after it was
-- counted, or with an adjustment asked for at the location, holds the count
-- up until it's counted again (stock_count_blocked): its difference may be
-- corrected already. Nobody is alerted (Craig, 2026-10-30: no alerts for
-- adjustments).
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
                   'customer_payments', 'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals',
                   'own_numbers', 'invoice_pdfs', 'stock_counts'));

INSERT INTO books_switches (piece) VALUES ('stock_counts') ON CONFLICT (piece) DO NOTHING;

-- ── The counts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stock_counts (
  -- Made by the route when Start is pressed, so a press sent twice is kept once. The adjustment's External ID in
  -- NetSuite is fleetsuite-count-<id>.
  id UUID PRIMARY KEY,
  -- Shown as CNT-0001.
  number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  location_id TEXT NOT NULL CHECK (location_id ~ '^[0-9]+$'),
  location_name TEXT NOT NULL CHECK (btrim(location_name) <> '' AND length(location_name) <= 200),
  -- What's on it, in words: everything NetSuite has there, the items matching a search, or the items picked.
  what TEXT NOT NULL CHECK (btrim(what) <> '' AND length(what) <= 200),
  -- The day its adjustment is dated in NetSuite.
  count_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'asked', 'sending', 'unsure', 'made', 'cancelled')),
  started_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  started_by_name TEXT CHECK (length(started_by_name) <= 200),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The ask for approval it's under, while it's asked, being posted, not known or made.
  asked_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  asked_by_name TEXT CHECK (length(asked_by_name) <= 200),
  asked_at TIMESTAMPTZ,
  -- The press of Approve that's posting it, posted it, or didn't hear back.
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  sent_by_name TEXT CHECK (length(sent_by_name) <= 200),
  sent_at TIMESTAMPTZ,
  -- Who made it (approved it, or finished it with nothing to post) or stopped it, and when.
  decided_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  decided_by_name TEXT CHECK (length(decided_by_name) <= 200),
  decided_at TIMESTAMPTZ,
  -- The last time it was turned down, and why, which the counters see until it's asked for again.
  turned_down_by_name TEXT CHECK (length(turned_down_by_name) <= 200),
  turned_down_at TIMESTAMPTZ,
  why TEXT CHECK (length(why) <= 300),
  netsuite_adjustment_id TEXT CHECK (netsuite_adjustment_id ~ '^[0-9]+$'),
  netsuite_adjustment_number TEXT CHECK (length(netsuite_adjustment_number) <= 60),
  -- Why NetSuite didn't post it, or why FleetSuite can't tell, the last time it was approved.
  error TEXT CHECK (length(error) <= 2000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status IN ('asked', 'sending', 'unsure')) = (asked_at IS NOT NULL) OR status = 'made'),
  CHECK (status NOT IN ('sending', 'unsure') OR sent_at IS NOT NULL),
  CHECK (status NOT IN ('made', 'cancelled') OR decided_at IS NOT NULL),
  -- Made after a press of Approve, it's NetSuite's adjustment; made without one, nothing was posted.
  CHECK (status <> 'made' OR (sent_at IS NULL) = (netsuite_adjustment_id IS NULL)),
  CHECK (netsuite_adjustment_id IS NULL OR status = 'made'),
  CHECK ((turned_down_at IS NULL) = (why IS NULL))
);

CREATE INDEX IF NOT EXISTS stock_counts_started_idx ON stock_counts (started_at DESC, id);

CREATE TABLE IF NOT EXISTS stock_count_lines (
  count_id UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  netsuite_item_id TEXT NOT NULL CHECK (netsuite_item_id ~ '^[0-9]+$'),
  -- The count's location, kept here so an item is on one open count per location.
  location_id TEXT NOT NULL CHECK (location_id ~ '^[0-9]+$'),
  part_id UUID REFERENCES netsuite_parts(id) ON DELETE SET NULL,
  item_number TEXT NOT NULL CHECK (btrim(item_number) <> '' AND length(item_number) <= 300),
  display_name TEXT CHECK (length(display_name) <= 500),
  -- Its place on the sheet.
  position INTEGER NOT NULL CHECK (position >= 1),
  -- NetSuite's live count at the location when it went on the count.
  on_hand_start NUMERIC NOT NULL,
  -- What was counted (blank until it is), and NetSuite's live count when that was saved, which the difference is from.
  counted NUMERIC CHECK (counted >= 0 AND counted = round(counted, 4)),
  on_hand_then NUMERIC,
  counted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  counted_by_name TEXT CHECK (length(counted_by_name) <= 200),
  counted_at TIMESTAMPTZ,
  -- While the count is being counted, asked for, posted or not known; false once it's made or stopped.
  is_open BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (count_id, netsuite_item_id),
  CHECK ((counted IS NULL) = (on_hand_then IS NULL)),
  CHECK ((counted IS NULL) = (counted_at IS NULL))
);

-- An item is on one open count per location.
CREATE UNIQUE INDEX IF NOT EXISTS stock_count_lines_one_open ON stock_count_lines (netsuite_item_id, location_id) WHERE is_open;
CREATE INDEX IF NOT EXISTS stock_count_lines_sheet_idx ON stock_count_lines (count_id, position);

-- The items on open counts at a location among these, with their count's number. p_items: NetSuite item ids.
CREATE OR REPLACE FUNCTION public.stock_count_taken(p_location TEXT, p_items TEXT[], p_except UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'netsuite_item_id', l.netsuite_item_id, 'item_number', l.item_number, 'count_id', c.id, 'number', c.number
  ) ORDER BY l.item_number, l.netsuite_item_id), '[]'::jsonb)
  FROM public.stock_count_lines l
  JOIN public.stock_counts c ON c.id = l.count_id
  WHERE l.is_open AND l.location_id = p_location AND l.netsuite_item_id = ANY (p_items) AND c.id IS DISTINCT FROM p_except;
$$;

-- The lines to put on a count, from p.lines: [{ netsuite_item_id, part_id?, item_number, display_name?, on_hand_start }].
-- Raises when one is missing what a line needs, or an item is there twice.
CREATE OR REPLACE FUNCTION public.stock_count_new_lines(p JSONB)
RETURNS TABLE (netsuite_item_id TEXT, part_id UUID, item_number TEXT, display_name TEXT, on_hand_start NUMERIC, n BIGINT)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF jsonb_typeof(p->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'lines') = 0 THEN
    RAISE EXCEPTION 'counts: a count needs an item to count';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p->'lines') e
    WHERE coalesce(e->>'netsuite_item_id', '') !~ '^[0-9]+$' OR btrim(coalesce(e->>'item_number', '')) = ''
      OR jsonb_typeof(e->'on_hand_start') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'counts: each item needs its NetSuite id, its number and NetSuite''s count';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p->'lines')) <> (SELECT count(DISTINCT e->>'netsuite_item_id') FROM jsonb_array_elements(p->'lines') e) THEN
    RAISE EXCEPTION 'counts: an item is on the list twice';
  END IF;
  RETURN QUERY
  SELECT e->>'netsuite_item_id', nullif(e->>'part_id', '')::uuid, btrim(e->>'item_number'),
         nullif(btrim(coalesce(e->>'display_name', '')), ''), (e->>'on_hand_start')::numeric, x.n
  FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS x(e, n);
END;
$$;

-- Starts a count. p:
--   { id, by, by_name?, location_id, location_name, what, count_date,
--     lines: [{ netsuite_item_id, part_id?, item_number, display_name?, on_hand_start }] }
-- in the order the sheet lists them, 500 at most. Answers { state, count, taken? } with:
--   'started'    started;
--   'same'       this press started it already;
--   'on_another' some of the items are on another open count at the location (taken: which, and its number), and
--                nothing is saved.
CREATE OR REPLACE FUNCTION public.stock_count_start(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_location TEXT := p->>'location_id';
  v_row public.stock_counts;
  v_items TEXT[];
  v_taken JSONB;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'counts: starting a count needs who started it';
  END IF;
  SELECT * INTO v_row FROM public.stock_counts WHERE id = v_id;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'same', 'count', to_jsonb(v_row));
  END IF;
  IF jsonb_typeof(p->'lines') = 'array' AND jsonb_array_length(p->'lines') > 500 THEN
    RAISE EXCEPTION 'counts: a count takes 500 items at most';
  END IF;
  SELECT array_agg(l.netsuite_item_id) INTO v_items FROM public.stock_count_new_lines(p) l;
  v_taken := public.stock_count_taken(v_location, v_items, NULL);
  IF jsonb_array_length(v_taken) > 0 THEN
    RETURN jsonb_build_object('state', 'on_another', 'taken', v_taken);
  END IF;

  BEGIN
    INSERT INTO public.stock_counts (id, location_id, location_name, what, count_date, started_by, started_by_name)
    VALUES (v_id, v_location, btrim(coalesce(p->>'location_name', '')), btrim(coalesce(p->>'what', '')), (p->>'count_date')::date,
            (p->>'by')::uuid, nullif(btrim(coalesce(p->>'by_name', '')), ''))
    RETURNING * INTO v_row;
    INSERT INTO public.stock_count_lines (count_id, netsuite_item_id, location_id, part_id, item_number, display_name, position, on_hand_start)
    SELECT v_id, l.netsuite_item_id, v_location, l.part_id, l.item_number, l.display_name, l.n, l.on_hand_start
    FROM public.stock_count_new_lines(p) l;
  EXCEPTION WHEN unique_violation THEN
    -- Another press got in first: this same one, or another count of some of the same items.
    SELECT * INTO v_row FROM public.stock_counts WHERE id = v_id;
    IF FOUND THEN
      RETURN jsonb_build_object('state', 'same', 'count', to_jsonb(v_row));
    END IF;
    RETURN jsonb_build_object('state', 'on_another', 'taken', public.stock_count_taken(v_location, v_items, NULL));
  END;
  RETURN jsonb_build_object('state', 'started', 'count', to_jsonb(v_row));
END;
$$;

-- Puts more items on a count while it's being counted, after the ones on it. p: { id, by, lines } as for
-- stock_count_start; items on it already are left as they are. Answers { state, added, taken? } with 'added',
-- 'on_another' (nothing is added), 'too_many' (it would go past 500), 'gone', or 'not_now' (status: where it is)
-- when it isn't being counted.
CREATE OR REPLACE FUNCTION public.stock_count_add(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.stock_counts;
  v_items TEXT[];
  v_taken JSONB;
  v_last INTEGER;
  v_have INTEGER;
  v_added INTEGER;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'counts: adding to a count needs who added';
  END IF;
  SELECT * INTO v_row FROM public.stock_counts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'counting' THEN
    RETURN jsonb_build_object('state', 'not_now', 'status', v_row.status);
  END IF;
  SELECT array_agg(l.netsuite_item_id) INTO v_items FROM public.stock_count_new_lines(p) l
  WHERE NOT EXISTS (SELECT 1 FROM public.stock_count_lines x WHERE x.count_id = v_row.id AND x.netsuite_item_id = l.netsuite_item_id);
  IF v_items IS NULL THEN
    RETURN jsonb_build_object('state', 'added', 'added', 0);
  END IF;
  SELECT count(*), coalesce(max(position), 0) INTO v_have, v_last FROM public.stock_count_lines WHERE count_id = v_row.id;
  IF v_have + cardinality(v_items) > 500 THEN
    RETURN jsonb_build_object('state', 'too_many', 'on_it', v_have);
  END IF;
  v_taken := public.stock_count_taken(v_row.location_id, v_items, v_row.id);
  IF jsonb_array_length(v_taken) > 0 THEN
    RETURN jsonb_build_object('state', 'on_another', 'taken', v_taken);
  END IF;
  BEGIN
    INSERT INTO public.stock_count_lines (count_id, netsuite_item_id, location_id, part_id, item_number, display_name, position, on_hand_start)
    SELECT v_row.id, l.netsuite_item_id, v_row.location_id, l.part_id, l.item_number, l.display_name,
           v_last + row_number() OVER (ORDER BY l.n), l.on_hand_start
    FROM public.stock_count_new_lines(p) l
    WHERE l.netsuite_item_id = ANY (v_items);
    GET DIAGNOSTICS v_added = ROW_COUNT;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('state', 'on_another', 'taken', public.stock_count_taken(v_row.location_id, v_items, v_row.id));
  END;
  UPDATE public.stock_counts SET updated_at = now() WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'added', 'added', v_added);
END;
$$;

-- Saves what was counted while a count is being counted. p:
--   { id, by, by_name?, count_date?, lines: [{ netsuite_item_id, counted, on_hand_then }] }
-- counted null clears an item back to not counted; otherwise on_hand_then is NetSuite's live count as it's saved, and
-- the item is kept as counted now, by whoever saved it, even when the count is what's kept already (counted again).
-- Answers { state, saved, missing? } with 'saved', 'not_on_count' (missing: the items that aren't on it, and nothing
-- is saved), 'gone', or 'not_now' (status: where it is) when it isn't being counted.
CREATE OR REPLACE FUNCTION public.stock_count_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.stock_counts;
  v_missing JSONB;
  v_saved INTEGER := 0;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'counts: saving a count needs who counted';
  END IF;
  IF jsonb_typeof(p->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'counts: saving a count needs its lines';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p->'lines') e
    WHERE coalesce(e->>'netsuite_item_id', '') !~ '^[0-9]+$'
      OR coalesce(jsonb_typeof(e->'counted'), 'missing') NOT IN ('number', 'null')
      OR (jsonb_typeof(e->'counted') = 'number' AND jsonb_typeof(e->'on_hand_then') IS DISTINCT FROM 'number')
  ) THEN
    RAISE EXCEPTION 'counts: each line saved needs its NetSuite id, its count, and NetSuite''s count as it''s saved';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p->'lines')) <> (SELECT count(DISTINCT e->>'netsuite_item_id') FROM jsonb_array_elements(p->'lines') e) THEN
    RAISE EXCEPTION 'counts: an item is saved twice';
  END IF;
  SELECT * INTO v_row FROM public.stock_counts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'counting' THEN
    RETURN jsonb_build_object('state', 'not_now', 'status', v_row.status);
  END IF;
  SELECT coalesce(jsonb_agg(e->>'netsuite_item_id' ORDER BY e->>'netsuite_item_id'), '[]'::jsonb) INTO v_missing
  FROM jsonb_array_elements(p->'lines') e
  WHERE NOT EXISTS (SELECT 1 FROM public.stock_count_lines l WHERE l.count_id = v_row.id AND l.netsuite_item_id = e->>'netsuite_item_id');
  IF jsonb_array_length(v_missing) > 0 THEN
    RETURN jsonb_build_object('state', 'not_on_count', 'missing', v_missing);
  END IF;

  UPDATE public.stock_count_lines l
  SET counted = s.counted,
      on_hand_then = CASE WHEN s.counted IS NULL THEN NULL ELSE s.hand END,
      counted_by = CASE WHEN s.counted IS NULL THEN NULL ELSE (p->>'by')::uuid END,
      counted_by_name = CASE WHEN s.counted IS NULL THEN NULL ELSE nullif(btrim(coalesce(p->>'by_name', '')), '') END,
      counted_at = CASE WHEN s.counted IS NULL THEN NULL ELSE now() END
  FROM (
    SELECT e->>'netsuite_item_id' AS item, (e->>'counted')::numeric AS counted, (e->>'on_hand_then')::numeric AS hand
    FROM jsonb_array_elements(p->'lines') e
  ) s
  WHERE l.count_id = v_row.id AND l.netsuite_item_id = s.item;
  GET DIAGNOSTICS v_saved = ROW_COUNT;

  UPDATE public.stock_counts
  SET count_date = coalesce(nullif(p->>'count_date', '')::date, count_date), updated_at = now()
  WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'saved', 'saved', v_saved);
END;
$$;

-- The items of a count that differ from NetSuite and can't be posted as counted: each adjusted with Adjust at the
-- location after it was counted (an adjustment in Adjust's history, or one asked for and made), or with an adjustment
-- asked for there that isn't decided yet. Their difference may be corrected already, so each is counted again first.
-- Answers [{ netsuite_item_id, item_number, why ('adjusted' | 'asked'), by_name, at }], in the sheet's order.
CREATE OR REPLACE FUNCTION public.stock_count_blocked(p_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(b.item ORDER BY b.position), '[]'::jsonb)
  FROM (
    SELECT l.position, jsonb_build_object(
      'netsuite_item_id', l.netsuite_item_id, 'item_number', l.item_number,
      'why', CASE WHEN o.at IS NOT NULL THEN 'asked' ELSE 'adjusted' END,
      'by_name', coalesce(o.by_name, a.by_name), 'at', coalesce(o.at, a.at)
    ) AS item
    FROM public.stock_count_lines l
    LEFT JOIN LATERAL (
      SELECT k.asked_by_name AS by_name, k.asked_at AS at
      FROM public.inventory_adjustment_asks k
      WHERE k.netsuite_item_id = l.netsuite_item_id AND k.location_id = l.location_id AND k.status IN ('waiting', 'sending', 'unsure')
      ORDER BY k.asked_at DESC
      LIMIT 1
    ) o ON true
    LEFT JOIN LATERAL (
      SELECT x.by_name, x.at FROM (
        SELECT j.created_by_name AS by_name, j.created_at AS at
        FROM public.inventory_adjustments j
        WHERE j.netsuite_item_id = l.netsuite_item_id AND j.location_id = l.location_id AND j.created_at > l.counted_at
        UNION ALL
        SELECT k.asked_by_name, k.decided_at
        FROM public.inventory_adjustment_asks k
        WHERE k.netsuite_item_id = l.netsuite_item_id AND k.location_id = l.location_id AND k.status = 'made' AND k.decided_at > l.counted_at
      ) x
      ORDER BY x.at DESC
      LIMIT 1
    ) a ON true
    WHERE l.count_id = p_id AND l.counted IS NOT NULL AND l.counted <> l.on_hand_then AND (o.at IS NOT NULL OR a.at IS NOT NULL)
  ) b;
$$;

-- The count's differences to post, in the sheet's order: [{ netsuite_item_id, item_number, change }].
CREATE OR REPLACE FUNCTION public.stock_count_changes(p_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'netsuite_item_id', l.netsuite_item_id, 'item_number', l.item_number, 'change', round(l.counted - l.on_hand_then, 4)
  ) ORDER BY l.position), '[]'::jsonb)
  FROM public.stock_count_lines l
  WHERE l.count_id = p_id AND l.counted IS NOT NULL AND round(l.counted - l.on_hand_then, 4) <> 0;
$$;

-- Asks for approval of a count's differences. p: { id, by, by_name? }. Answers { state, count, blocked?, status? } with:
--   'asked'         asked;
--   'none_counted'  nothing on it is counted yet;
--   'no_differences' every item counted matches NetSuite, so it's finished instead (stock_count_finish);
--   'blocked'       some items differ and were adjusted after they were counted, or have an adjustment asked for
--                   (blocked: which), so they're counted again first;
--   'gone', or 'not_now' (status: where it is) when it isn't being counted, so a second press doesn't read as asked.
CREATE OR REPLACE FUNCTION public.stock_count_ask(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.stock_counts;
  v_blocked JSONB;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'counts: asking for approval needs who asked';
  END IF;
  SELECT * INTO v_row FROM public.stock_counts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'counting' THEN
    RETURN jsonb_build_object('state', 'not_now', 'status', v_row.status, 'count', to_jsonb(v_row));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stock_count_lines WHERE count_id = v_row.id AND counted IS NOT NULL) THEN
    RETURN jsonb_build_object('state', 'none_counted', 'count', to_jsonb(v_row));
  END IF;
  IF jsonb_array_length(public.stock_count_changes(v_row.id)) = 0 THEN
    RETURN jsonb_build_object('state', 'no_differences', 'count', to_jsonb(v_row));
  END IF;
  v_blocked := public.stock_count_blocked(v_row.id);
  IF jsonb_array_length(v_blocked) > 0 THEN
    RETURN jsonb_build_object('state', 'blocked', 'blocked', v_blocked, 'count', to_jsonb(v_row));
  END IF;
  UPDATE public.stock_counts
  SET status = 'asked', asked_by = (p->>'by')::uuid, asked_by_name = nullif(btrim(coalesce(p->>'by_name', '')), ''), asked_at = now(),
      turned_down_by_name = NULL, turned_down_at = NULL, why = NULL, error = NULL, updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'asked', 'count', to_jsonb(v_row));
END;
$$;

-- Finishes a count whose every item counted matches NetSuite: nothing is posted. p: { id, by, by_name? }. Answers
-- { state, count, status? } with 'finished', 'none_counted', 'differences' (ask for approval instead), 'gone', or
-- 'not_now' (status: where it is) when it isn't being counted.
CREATE OR REPLACE FUNCTION public.stock_count_finish(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.stock_counts;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'counts: finishing a count needs who finished it';
  END IF;
  SELECT * INTO v_row FROM public.stock_counts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'counting' THEN
    RETURN jsonb_build_object('state', 'not_now', 'status', v_row.status, 'count', to_jsonb(v_row));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stock_count_lines WHERE count_id = v_row.id AND counted IS NOT NULL) THEN
    RETURN jsonb_build_object('state', 'none_counted', 'count', to_jsonb(v_row));
  END IF;
  IF jsonb_array_length(public.stock_count_changes(v_row.id)) > 0 THEN
    RETURN jsonb_build_object('state', 'differences', 'count', to_jsonb(v_row));
  END IF;
  UPDATE public.stock_count_lines SET is_open = false WHERE count_id = v_row.id;
  UPDATE public.stock_counts
  SET status = 'made', decided_by = (p->>'by')::uuid, decided_by_name = nullif(btrim(coalesce(p->>'by_name', '')), ''), decided_at = now(),
      updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'finished', 'count', to_jsonb(v_row));
END;
$$;

-- Stops a count while it's being counted: nothing is posted, and its items can go on another count. p: { id, by,
-- by_name? }. Answers { state, count, status? } with 'cancelled', 'gone', or 'not_now' (status: where it is) when
-- it isn't being counted, so stopping one stopped already doesn't read as stopped now.
CREATE OR REPLACE FUNCTION public.stock_count_cancel(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.stock_counts;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'counts: stopping a count needs who stopped it';
  END IF;
  SELECT * INTO v_row FROM public.stock_counts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'counting' THEN
    RETURN jsonb_build_object('state', 'not_now', 'status', v_row.status, 'count', to_jsonb(v_row));
  END IF;
  UPDATE public.stock_count_lines SET is_open = false WHERE count_id = v_row.id;
  UPDATE public.stock_counts
  SET status = 'cancelled', decided_by = (p->>'by')::uuid, decided_by_name = nullif(btrim(coalesce(p->>'by_name', '')), ''),
      decided_at = now(), updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'cancelled', 'count', to_jsonb(v_row));
END;
$$;

-- Withdraws an ask for approval, by whoever asked, so it's counted again. p: { id, by }. Answers { state, count }
-- with 'withdrawn', 'not_yours', 'gone', or 'not_now' (status: where it is) when it isn't asked for.
CREATE OR REPLACE FUNCTION public.stock_count_withdraw(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.stock_counts;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'counts: withdrawing an ask needs who withdrew it';
  END IF;
  SELECT * INTO v_row FROM public.stock_counts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'asked' THEN
    RETURN jsonb_build_object('state', 'not_now', 'status', v_row.status, 'count', to_jsonb(v_row));
  END IF;
  IF v_row.asked_by IS DISTINCT FROM (p->>'by')::uuid THEN
    RETURN jsonb_build_object('state', 'not_yours', 'count', to_jsonb(v_row));
  END IF;
  UPDATE public.stock_counts
  SET status = 'counting', asked_by = NULL, asked_by_name = NULL, asked_at = NULL, error = NULL, updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'withdrawn', 'count', to_jsonb(v_row));
END;
$$;

-- Turns down an ask for approval, saying why, so it's counted again; whoever asked withdraws it instead. p: { id, by,
-- by_name?, why }. Answers { state, count, status? } with 'turned_down', 'own', 'gone', or 'not_now' (status: where
-- it is) when it isn't asked for.
CREATE OR REPLACE FUNCTION public.stock_count_turn_down(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_why TEXT := btrim(coalesce(p->>'why', ''));
  v_row public.stock_counts;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'counts: turning an ask down needs who turned it down';
  END IF;
  IF v_why = '' OR length(v_why) > 300 THEN
    RAISE EXCEPTION 'counts: turning an ask down needs why, 300 characters at most';
  END IF;
  SELECT * INTO v_row FROM public.stock_counts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'asked' THEN
    RETURN jsonb_build_object('state', 'not_now', 'status', v_row.status, 'count', to_jsonb(v_row));
  END IF;
  IF v_row.asked_by = (p->>'by')::uuid THEN
    RETURN jsonb_build_object('state', 'own', 'count', to_jsonb(v_row));
  END IF;
  UPDATE public.stock_counts
  SET status = 'counting', asked_by = NULL, asked_by_name = NULL, asked_at = NULL, error = NULL,
      turned_down_by_name = nullif(btrim(coalesce(p->>'by_name', '')), ''), turned_down_at = now(), why = v_why, updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'turned_down', 'count', to_jsonb(v_row));
END;
$$;

-- Takes the claim for a press of Approve, to post the count's differences in NetSuite. p: { id, by, by_name? }.
-- Answers { state, count, changes?, blocked?, status? } with:
--   'claimed'  this press now holds it (changes: what to post);
--   'own'      whoever pressed asked for it, and a super admin who didn't approves it; nothing changes;
--   'blocked'  some items were adjusted after they were counted (blocked: which); it stays asked, to turn down;
--   'gone', or 'not_now' when it isn't asked for, with status where it is: 'counting', 'sending' (a press is
--   posting it, since sent_at), 'unsure', 'made' or 'cancelled'.
CREATE OR REPLACE FUNCTION public.stock_count_claim(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.stock_counts;
  v_blocked JSONB;
BEGIN
  IF nullif(p->>'by', '') IS NULL THEN
    RAISE EXCEPTION 'counts: an approval needs who approved';
  END IF;
  SELECT * INTO v_row FROM public.stock_counts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.status <> 'asked' THEN
    RETURN jsonb_build_object('state', 'not_now', 'status', v_row.status, 'count', to_jsonb(v_row));
  END IF;
  IF v_row.asked_by = (p->>'by')::uuid THEN
    RETURN jsonb_build_object('state', 'own', 'count', to_jsonb(v_row));
  END IF;
  v_blocked := public.stock_count_blocked(v_row.id);
  IF jsonb_array_length(v_blocked) > 0 THEN
    RETURN jsonb_build_object('state', 'blocked', 'blocked', v_blocked, 'count', to_jsonb(v_row));
  END IF;
  UPDATE public.stock_counts
  SET status = 'sending', sent_by = (p->>'by')::uuid, sent_by_name = nullif(btrim(coalesce(p->>'by_name', '')), ''), sent_at = now(),
      error = NULL, updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'claimed', 'count', to_jsonb(v_row), 'changes', public.stock_count_changes(v_row.id));
END;
$$;

-- Lets go of a press NetSuite didn't post it for, or that NetSuite has nothing from, keeping why, so it waits to be
-- approved again. p: { id, error }. Returns { let_go }.
CREATE OR REPLACE FUNCTION public.stock_count_let_go(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.stock_counts
  SET status = 'asked', sent_by = NULL, sent_by_name = NULL, sent_at = NULL,
      error = left(coalesce(nullif(btrim(p->>'error'), ''), 'Not posted'), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status IN ('sending', 'unsure');
  RETURN jsonb_build_object('let_go', FOUND);
END;
$$;

-- Keeps that a press didn't hear back whether NetSuite posted it, with why. p: { id, error }. Returns { unsure }.
CREATE OR REPLACE FUNCTION public.stock_count_unsure(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.stock_counts
  SET status = 'unsure', error = left(coalesce(nullif(btrim(p->>'error'), ''), 'No answer from NetSuite'), 2000), updated_at = now()
  WHERE id = (p->>'id')::uuid AND status = 'sending';
  RETURN jsonb_build_object('unsure', FOUND);
END;
$$;

-- Keeps the adjustment NetSuite has for a press, and closes the count's items. p: { id, netsuite_adjustment_id,
-- netsuite_number? }. Returns { made }: false when it isn't being posted or not known (made already, or let go).
CREATE OR REPLACE FUNCTION public.stock_count_made(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
BEGIN
  IF coalesce(p->>'netsuite_adjustment_id', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'counts: a count made in NetSuite needs NetSuite''s id for its adjustment';
  END IF;
  UPDATE public.stock_counts
  SET status = 'made', netsuite_adjustment_id = p->>'netsuite_adjustment_id',
      netsuite_adjustment_number = left(nullif(btrim(coalesce(p->>'netsuite_number', '')), ''), 60),
      decided_by = sent_by, decided_by_name = sent_by_name, decided_at = now(), error = NULL, updated_at = now()
  WHERE id = v_id AND status IN ('sending', 'unsure');
  IF NOT FOUND THEN
    RETURN jsonb_build_object('made', false);
  END IF;
  UPDATE public.stock_count_lines SET is_open = false WHERE count_id = v_id;
  RETURN jsonb_build_object('made', true);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.stock_counts', 'public.stock_count_lines'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.stock_count_taken(text, text[], uuid)', 'public.stock_count_new_lines(jsonb)', 'public.stock_count_start(jsonb)',
    'public.stock_count_add(jsonb)', 'public.stock_count_save(jsonb)', 'public.stock_count_blocked(uuid)',
    'public.stock_count_changes(uuid)', 'public.stock_count_ask(jsonb)', 'public.stock_count_finish(jsonb)',
    'public.stock_count_cancel(jsonb)', 'public.stock_count_withdraw(jsonb)', 'public.stock_count_turn_down(jsonb)',
    'public.stock_count_claim(jsonb)', 'public.stock_count_let_go(jsonb)', 'public.stock_count_unsure(jsonb)',
    'public.stock_count_made(jsonb)'
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

COMMENT ON TABLE stock_counts IS 'Migration 499: each stock count at a location (src/lib/stock-counts.ts, /admin/inventory/counts): what''s on it, the day its adjustment is dated, and where it is, from being counted to asked for, posted in NetSuite as one Inventory Adjustment once a super admin who didn''t ask approves it, finished with nothing to post, or stopped. Moved only by its functions. Service-role write and read.';
COMMENT ON TABLE stock_count_lines IS 'Migration 499: each item on a stock count, with NetSuite''s count when it went on and, once counted, the count and NetSuite''s count when it was saved, which its difference is from. One open count per item and location. Service-role write and read.';
COMMENT ON FUNCTION public.stock_count_start(jsonb) IS 'Migration 499: starts a stock count of up to 500 items at a location, unless some are on another open count there. Service role only.';
COMMENT ON FUNCTION public.stock_count_add(jsonb) IS 'Migration 499: puts more items on a stock count while it''s being counted. Service role only.';
COMMENT ON FUNCTION public.stock_count_save(jsonb) IS 'Migration 499: saves what was counted, with NetSuite''s count as it''s saved, while a count is being counted. Service role only.';
COMMENT ON FUNCTION public.stock_count_blocked(uuid) IS 'Migration 499: a count''s items that differ and were adjusted after they were counted, or have an adjustment asked for. Service role only.';
COMMENT ON FUNCTION public.stock_count_changes(uuid) IS 'Migration 499: a count''s differences from NetSuite, to post. Service role only.';
COMMENT ON FUNCTION public.stock_count_ask(jsonb) IS 'Migration 499: asks for approval of a count''s differences. Service role only.';
COMMENT ON FUNCTION public.stock_count_finish(jsonb) IS 'Migration 499: finishes a count whose every item counted matches NetSuite, posting nothing. Service role only.';
COMMENT ON FUNCTION public.stock_count_cancel(jsonb) IS 'Migration 499: stops a count while it''s being counted, posting nothing. Service role only.';
COMMENT ON FUNCTION public.stock_count_withdraw(jsonb) IS 'Migration 499: withdraws an ask for approval of a count, by whoever asked. Service role only.';
COMMENT ON FUNCTION public.stock_count_turn_down(jsonb) IS 'Migration 499: turns down an ask for approval of a count, saying why, by someone who didn''t ask. Service role only.';
COMMENT ON FUNCTION public.stock_count_claim(jsonb) IS 'Migration 499: takes the claim for a press of Approve by someone who didn''t ask, to post the count in NetSuite. Service role only.';
COMMENT ON FUNCTION public.stock_count_let_go(jsonb) IS 'Migration 499: puts a count NetSuite didn''t post back to wait for approval, keeping why. Service role only.';
COMMENT ON FUNCTION public.stock_count_unsure(jsonb) IS 'Migration 499: keeps that a press didn''t hear back whether NetSuite posted a count. Service role only.';
COMMENT ON FUNCTION public.stock_count_made(jsonb) IS 'Migration 499: keeps the adjustment NetSuite has for a count, and closes its items. Service role only.';
