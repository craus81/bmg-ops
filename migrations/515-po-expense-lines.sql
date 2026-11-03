-- Migration 515: a purchase order's other lines on FleetSuite's copy.
--
-- Books gap (NetSuite Exit Checklist, "Gaps in what's built"; thread
-- "Replacing NetSuite with FleetSuite", 2026-11-03): FleetSuite's copy of a
-- PO (netsuite_vendor_pos and netsuite_vendor_po_lines, kept by the vendor PO
-- sync) kept only the PO's item lines, so the lines on its Expenses tab,
-- freight say, didn't show. A bill FleetSuite makes from a PO in NetSuite
-- (Parts Mail's Create bill, Snap a bill's Bill PO) bills those lines too, so
-- Books' own copy of the bill and Snap a bill's "What NetSuite bills" came out
-- short by them. The sync (src/lib/vendor-po-sync.ts) now keeps them here,
-- each with the bills NetSuite shows it on, so a bill made from the PO knows
-- which of them it takes.
--
--   * account_netsuite_id / account_name: the line's account, NetSuite's id
--     and name (the name null when NetSuite wouldn't give it);
--   * memo, amount: as the PO has them (the amount null when NetSuite gave
--     none FleetSuite can read);
--   * closed: NetSuite closed the line, so no bill takes it; null when the
--     sync couldn't read it;
--   * billed_by: NetSuite's ids for the bills that have the line, empty when
--     none does; null when the sync couldn't read them.
--
-- netsuite_vendor_pos.expense_lines_read_at is when the sync last read a PO's
-- other lines: null until it has, so a bill made from the PO says it doesn't
-- know them rather than take it there are none. The sync reads them for every
-- PO NetSuite changed, and up to a hundred of the rest each run, newest
-- first, until it has read them all.
--
-- The item lines stay where they were, so nothing that reads them (Receiving,
-- what's on order, parts readiness) changes.
--
-- Writer: the sync, through vendor_po_expense_lines_put (service role only),
-- which replaces the lines of the POs it's given and marks them read in one
-- go. Readers: the service role, and staff as they read the rest of the copy.

CREATE TABLE IF NOT EXISTS public.netsuite_vendor_po_expense_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES public.netsuite_vendor_pos(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL CHECK (line_id ~ '^[0-9]+$'),
  account_netsuite_id TEXT CHECK (account_netsuite_id ~ '^[0-9]+$'),
  account_name TEXT,
  memo TEXT,
  amount NUMERIC(14,2),
  closed BOOLEAN,
  billed_by TEXT[] CHECK (cardinality(billed_by) = 0 OR array_to_string(billed_by, ',', '-') ~ '^[0-9]+(,[0-9]+)*$'),
  UNIQUE (po_id, line_id)
);

ALTER TABLE public.netsuite_vendor_pos ADD COLUMN IF NOT EXISTS expense_lines_read_at TIMESTAMPTZ;

-- Staff read, as they read the rest of the copy; writes come from the sync (service role).
ALTER TABLE public.netsuite_vendor_po_expense_lines ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read vendor PO expense lines' AND tablename = 'netsuite_vendor_po_expense_lines') THEN
    CREATE POLICY "Staff read vendor PO expense lines" ON public.netsuite_vendor_po_expense_lines
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;

-- ── Writing: replace the other lines of some POs and mark them read ────────
--
-- p_pos: [{ po_id, lines: [{ line_id, account_netsuite_id?, account_name?,
-- memo?, amount?, closed?, billed_by? }] }]. A PO the copy no longer has is
-- left out. Returns how many lines it kept.

CREATE OR REPLACE FUNCTION public.vendor_po_expense_lines_put(p_pos JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ids UUID[];
  v_lines INTEGER;
BEGIN
  IF p_pos IS NULL OR jsonb_typeof(p_pos) <> 'array' THEN
    RAISE EXCEPTION 'vendor_po_expense_lines_put takes a list of purchase orders';
  END IF;

  SELECT coalesce(array_agg(p.id), '{}') INTO v_ids
  FROM public.netsuite_vendor_pos p
  WHERE p.id IN (SELECT (e->>'po_id')::uuid FROM jsonb_array_elements(p_pos) e);

  DELETE FROM public.netsuite_vendor_po_expense_lines WHERE po_id = ANY (v_ids);

  INSERT INTO public.netsuite_vendor_po_expense_lines
    (po_id, line_id, account_netsuite_id, account_name, memo, amount, closed, billed_by)
  SELECT
    (e->>'po_id')::uuid,
    l->>'line_id',
    nullif(l->>'account_netsuite_id', ''),
    nullif(l->>'account_name', ''),
    nullif(l->>'memo', ''),
    (l->>'amount')::numeric,
    (l->>'closed')::boolean,
    CASE WHEN jsonb_typeof(l->'billed_by') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(l->'billed_by')) END
  FROM jsonb_array_elements(p_pos) e
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e->'lines') = 'array' THEN e->'lines' ELSE '[]'::jsonb END) l
  WHERE (e->>'po_id')::uuid = ANY (v_ids);
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  UPDATE public.netsuite_vendor_pos SET expense_lines_read_at = now() WHERE id = ANY (v_ids);
  RETURN v_lines;
END
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.vendor_po_expense_lines_put(jsonb) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.vendor_po_expense_lines_put(jsonb) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.vendor_po_expense_lines_put(jsonb) TO service_role;
  END IF;
END $$;

COMMENT ON TABLE public.netsuite_vendor_po_expense_lines IS
  'Migration 515: each purchase order''s other lines (its Expenses tab: freight, say), as the vendor PO sync last read them from NetSuite, each with the bills NetSuite shows it on (billed_by; null when the sync couldn''t read them).';
COMMENT ON COLUMN public.netsuite_vendor_pos.expense_lines_read_at IS
  'Migration 515: when the vendor PO sync last read the PO''s other lines into netsuite_vendor_po_expense_lines; null until it has.';
COMMENT ON FUNCTION public.vendor_po_expense_lines_put(jsonb) IS
  'Migration 515: replaces the other lines of the purchase orders given and marks each read; service role only.';
