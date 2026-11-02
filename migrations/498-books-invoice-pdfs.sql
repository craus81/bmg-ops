-- Migration 498: FleetSuite's own books, part 68 — FleetSuite's own PDF of
-- each invoice it makes, attached to NetSuite's invoice, switched off.
--
-- The rest of the NetSuite Exit Checklist's "FleetSuite's own numbers" (thread
-- "Replacing NetSuite with FleetSuite"; src/lib/books/own-invoice-pdf.ts,
-- src/lib/books/invoice-pdfs.ts, /api/admin/books/own-invoices/pdf,
-- /api/cron/books-invoice-pdfs, docs/books.md "Invoice PDFs"). FleetSuite
-- draws its own PDF of each invoice it makes from its own copy (migration
-- 407), and Books opens it. Once Invoice PDFs is switched on, FleetSuite
-- attaches it to NetSuite's invoice through the PDF script in NetSuite
-- (scripts/netsuite-pdf-restlet.js), so the invoice in NetSuite carries the
-- document as FleetSuite made it, once FleetSuite's copy matches it:
--
--   * books_switches gets 'invoice_pdfs', off;
--   * own_invoice_pdfs, a row for each version of FleetSuite's copy of an
--     invoice (migration 471 makes the next when FleetSuite fixes it) that
--     FleetSuite looked at: held back, because the copy differs from NetSuite's
--     invoice, is incomplete, NetSuite voided the invoice, or FleetSuite's copy
--     of NetSuite's invoice isn't there yet; on its way to NetSuite; attached,
--     with NetSuite's id for the file; refused, with NetSuite's reason; or not
--     sure NetSuite has it;
--   * own_invoice_pdfs_due(p_since, p_limit): the copies made since p_since to
--     look at next, the ones never looked at first: held back 20 hours or more
--     ago while the invoice is under 60 days old (a voided one stays held), or
--     waiting for NetSuite's invoice 90 minutes or more ago in its first three
--     days; refused 20 hours or more ago; not sure an hour or more ago; or
--     still on its way 15 minutes on, each under three tries;
--   * own_invoice_pdf_hold(...), own_invoice_pdf_claim(...) and
--     own_invoice_pdf_settle(...): held back; on its way, one at a time and
--     only for the copy's current version, naming the file of an earlier
--     version NetSuite has, to take off the invoice; and what NetSuite
--     answered, once;
--   * own_invoice_pdf_state(p_invoice): the copy's version and each version's
--     row, for the invoice's page;
--   * own_invoice_pdfs_to_tell(p_limit) and own_invoice_pdfs_mark_told(...),
--     for the daily check: the current versions NetSuite refused, or that
--     FleetSuite is still unsure about after three tries, that the two-hourly
--     run sent and it hasn't told about.
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
                   'own_numbers', 'invoice_pdfs'));

INSERT INTO books_switches (piece) VALUES ('invoice_pdfs') ON CONFLICT (piece) DO NOTHING;

-- ── Each copy's PDF ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS own_invoice_pdfs (
  invoice_id TEXT NOT NULL REFERENCES gl_own_invoices(netsuite_id) ON DELETE CASCADE,
  -- The version of FleetSuite's copy the PDF is drawn from (gl_own_invoices.version).
  version INTEGER NOT NULL CHECK (version >= 1),
  -- 'held': not sent, held_for says why; 'sending': on its way to NetSuite; 'attached': on NetSuite's invoice;
  -- 'refused': NetSuite said no; 'unsure': FleetSuite doesn't know whether NetSuite has it.
  state TEXT NOT NULL CHECK (state IN ('held', 'sending', 'attached', 'refused', 'unsure')),
  held_for TEXT CHECK (held_for IN ('differs', 'incomplete', 'voided', 'waiting')),
  -- The file's name in NetSuite's File Cabinet, NetSuite's id for the invoice in it (netsuitePdfFilename).
  file_name TEXT CHECK (file_name ~ '^[A-Za-z0-9_.-]{1,120}\.pdf$'),
  -- NetSuite's id for the file, once it's on the invoice.
  file_id TEXT CHECK (file_id ~ '^[0-9]{1,20}$'),
  -- The file of an earlier version NetSuite was asked to take off the invoice, and whether it did.
  replaced_file_id TEXT CHECK (replaced_file_id ~ '^[0-9]{1,20}$'),
  replaced BOOLEAN,
  tries INTEGER NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 1000),
  error TEXT CHECK (error IS NULL OR length(error) <= 600),
  -- Who sent it from the invoice's page; null for the two-hourly run.
  asked_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  told_at TIMESTAMPTZ,
  PRIMARY KEY (invoice_id, version),
  CHECK ((state = 'held') = (held_for IS NOT NULL)),
  CHECK (state <> 'sending' OR (started_at IS NOT NULL AND file_name IS NOT NULL)),
  CHECK (state <> 'attached' OR (file_id IS NOT NULL AND answered_at IS NOT NULL)),
  CHECK (state NOT IN ('refused', 'unsure') OR (error IS NOT NULL AND answered_at IS NOT NULL)),
  CHECK (replaced IS NULL OR replaced_file_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_own_invoice_pdfs_tell ON own_invoice_pdfs(answered_at) WHERE told_at IS NULL;

-- ── Which to look at ───────────────────────────────────────────────────────

-- The current versions of FleetSuite's copies made since p_since to look at next, the ones never looked at first, then
-- the longest waiting: [{ netsuite_id, version }].
CREATE OR REPLACE FUNCTION public.own_invoice_pdfs_due(p_since TIMESTAMPTZ, p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_since IS NULL THEN
    RAISE EXCEPTION 'own invoice pdfs: say since when';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'own invoice pdfs: p_limit must be 1 to 200';
  END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object('netsuite_id', d.netsuite_id, 'version', d.version)
                              ORDER BY d.looked, d.waiting, d.netsuite_id::bigint), '[]'::jsonb)
    FROM (
      SELECT o.netsuite_id, o.version, p.invoice_id IS NOT NULL AS looked, coalesce(p.checked_at, o.made_at) AS waiting
      FROM public.gl_own_invoices o
      LEFT JOIN public.own_invoice_pdfs p ON p.invoice_id = o.netsuite_id AND p.version = o.version
      WHERE o.made_at >= p_since
        AND (
          p.invoice_id IS NULL
          OR (p.tries < 3 AND (
               (p.state = 'held' AND p.held_for <> 'voided' AND o.made_at >= now() - interval '60 days'
                AND (p.checked_at <= now() - interval '20 hours'
                     OR (p.held_for = 'waiting' AND o.made_at >= now() - interval '3 days'
                         AND p.checked_at <= now() - interval '90 minutes')))
            OR (p.state = 'refused' AND p.answered_at <= now() - interval '20 hours')
            OR (p.state = 'unsure' AND p.answered_at <= now() - interval '1 hour')
            OR (p.state = 'sending' AND p.started_at <= now() - interval '15 minutes')
          ))
        )
      ORDER BY p.invoice_id IS NOT NULL, coalesce(p.checked_at, o.made_at), o.netsuite_id::bigint
      LIMIT p_limit
    ) d
  );
END;
$$;

-- ── Held back, on its way, answered ────────────────────────────────────────

-- Holds back the PDF of a copy's current version: its copy differs from NetSuite's invoice, is incomplete, NetSuite
-- voided the invoice, or FleetSuite's copy of NetSuite's invoice isn't there yet. Not one NetSuite has, or one on its
-- way. Returns whether it was held.
CREATE OR REPLACE FUNCTION public.own_invoice_pdf_hold(p_invoice TEXT, p_version INTEGER, p_for TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_version INTEGER;
  v_rows INTEGER;
BEGIN
  IF p_for IS NULL OR p_for NOT IN ('differs', 'incomplete', 'voided', 'waiting') THEN
    RAISE EXCEPTION 'own invoice pdfs: % isn''t a reason to hold one back', coalesce(p_for, 'nothing');
  END IF;
  SELECT version INTO v_version FROM public.gl_own_invoices WHERE netsuite_id = p_invoice FOR UPDATE;
  IF v_version IS NULL OR v_version IS DISTINCT FROM p_version THEN
    RETURN false;
  END IF;
  INSERT INTO public.own_invoice_pdfs AS p (invoice_id, version, state, held_for, checked_at)
  VALUES (p_invoice, p_version, 'held', p_for, now())
  ON CONFLICT (invoice_id, version) DO UPDATE
    SET state = 'held', held_for = excluded.held_for, checked_at = now(), error = NULL, answered_at = NULL
    WHERE p.state IN ('held', 'refused', 'unsure')
       OR (p.state = 'sending' AND p.started_at <= now() - interval '15 minutes');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- Puts the PDF of a copy's version on its way to NetSuite as p_file_name, by p_by (null for the two-hourly run). Only
-- the copy's current version, one at a time, never one NetSuite has, and not after three tries unless p_again (a
-- super admin sending it from the invoice's page). Returns { claimed, why?, replace_file_id, tries }: replace_file_id
-- is the file of the newest earlier version on NetSuite's invoice, to take off it once this one is on.
CREATE OR REPLACE FUNCTION public.own_invoice_pdf_claim(
  p_invoice TEXT, p_version INTEGER, p_file_name TEXT, p_by UUID, p_again BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_version INTEGER;
  v_row public.own_invoice_pdfs;
  v_replace TEXT;
  v_tries INTEGER;
  v_by UUID;
BEGIN
  IF p_file_name IS NULL OR p_file_name !~ '^[A-Za-z0-9_.-]{1,120}\.pdf$' THEN
    RAISE EXCEPTION 'own invoice pdfs: % isn''t a file name NetSuite takes', coalesce(p_file_name, 'no name');
  END IF;
  -- The copy's row first: two at once for the same invoice wait for each other here.
  SELECT version INTO v_version FROM public.gl_own_invoices WHERE netsuite_id = p_invoice FOR UPDATE;
  IF v_version IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'why', 'missing');
  END IF;
  IF v_version IS DISTINCT FROM p_version THEN
    RETURN jsonb_build_object('claimed', false, 'why', 'changed');
  END IF;
  SELECT * INTO v_row FROM public.own_invoice_pdfs WHERE invoice_id = p_invoice AND version = p_version;
  IF FOUND THEN
    IF v_row.state = 'attached' THEN
      RETURN jsonb_build_object('claimed', false, 'why', 'attached');
    END IF;
    IF v_row.state = 'sending' AND v_row.started_at > now() - interval '15 minutes' THEN
      RETURN jsonb_build_object('claimed', false, 'why', 'sending');
    END IF;
    IF v_row.tries >= 3 AND NOT coalesce(p_again, false) THEN
      RETURN jsonb_build_object('claimed', false, 'why', 'tries');
    END IF;
  END IF;

  -- Someone whose profile is gone sends it as nobody.
  SELECT id INTO v_by FROM public.profiles WHERE id = p_by;

  SELECT p.file_id INTO v_replace
  FROM public.own_invoice_pdfs p
  WHERE p.invoice_id = p_invoice AND p.version < p_version AND p.state = 'attached'
  ORDER BY p.version DESC
  LIMIT 1;

  INSERT INTO public.own_invoice_pdfs AS p (
    invoice_id, version, state, file_name, replaced_file_id, tries, asked_by, checked_at, started_at
  ) VALUES (p_invoice, p_version, 'sending', p_file_name, v_replace, 1, v_by, now(), now())
  ON CONFLICT (invoice_id, version) DO UPDATE
    SET state = 'sending', held_for = NULL, file_name = excluded.file_name, file_id = NULL,
        replaced_file_id = excluded.replaced_file_id, replaced = NULL, tries = p.tries + 1, error = NULL,
        asked_by = excluded.asked_by, checked_at = now(), started_at = now(), answered_at = NULL
  RETURNING p.tries INTO v_tries;
  RETURN jsonb_build_object('claimed', true, 'replace_file_id', v_replace, 'tries', v_tries);
END;
$$;

-- What NetSuite answered for a PDF on its way: 'attached' with its id for the file and, when an earlier version's file
-- was to come off the invoice, whether it did; 'refused' or 'unsure' with what went wrong. Once. Returns whether it
-- was on its way.
CREATE OR REPLACE FUNCTION public.own_invoice_pdf_settle(
  p_invoice TEXT, p_version INTEGER, p_state TEXT, p_file_id TEXT, p_replaced BOOLEAN, p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('attached', 'refused', 'unsure') THEN
    RAISE EXCEPTION 'own invoice pdfs: % isn''t an answer', coalesce(p_state, 'nothing');
  END IF;
  IF p_state = 'attached' AND (p_file_id IS NULL OR p_file_id !~ '^[0-9]{1,20}$') THEN
    RAISE EXCEPTION 'own invoice pdfs: an attached PDF needs NetSuite''s id for the file';
  END IF;
  IF p_state <> 'attached' AND nullif(btrim(coalesce(p_error, '')), '') IS NULL THEN
    RAISE EXCEPTION 'own invoice pdfs: say what went wrong';
  END IF;
  UPDATE public.own_invoice_pdfs
  SET state = p_state,
      file_id = CASE WHEN p_state = 'attached' THEN p_file_id END,
      replaced = CASE WHEN p_state = 'attached' AND replaced_file_id IS NOT NULL THEN p_replaced END,
      error = CASE WHEN p_state = 'attached' THEN NULL ELSE left(btrim(p_error), 600) END,
      answered_at = now()
  WHERE invoice_id = p_invoice AND version = p_version AND state = 'sending';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- ── Readers ────────────────────────────────────────────────────────────────

-- The invoice's page: { version, made_at, pdfs: [{ version, state, held_for, file_name, file_id, replaced_file_id,
-- replaced, tries, error, asked_by_name, checked_at, started_at, answered_at }], newest version first }, or null when
-- FleetSuite has no copy of the invoice.
CREATE OR REPLACE FUNCTION public.own_invoice_pdf_state(p_invoice TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'version', o.version,
    'made_at', o.made_at,
    'pdfs', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'version', p.version, 'state', p.state, 'held_for', p.held_for, 'file_name', p.file_name,
        'file_id', p.file_id, 'replaced_file_id', p.replaced_file_id, 'replaced', p.replaced, 'tries', p.tries,
        'error', p.error, 'asked_by_name', pr.full_name, 'checked_at', p.checked_at, 'started_at', p.started_at,
        'answered_at', p.answered_at
      ) ORDER BY p.version DESC), '[]'::jsonb)
      FROM public.own_invoice_pdfs p
      LEFT JOIN public.profiles pr ON pr.id = p.asked_by
      WHERE p.invoice_id = o.netsuite_id
    )
  )
  FROM public.gl_own_invoices o
  WHERE o.netsuite_id = p_invoice
$$;

-- For the daily check: the current versions the two-hourly run sent that NetSuite refused, or that FleetSuite is
-- still unsure about after three tries (one still on its way 15 minutes on never heard back), that it hasn't told
-- about, the longest waiting first: [{ invoice_id, version, number, state, error, tries }].
CREATE OR REPLACE FUNCTION public.own_invoice_pdfs_to_tell(p_limit INTEGER)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'invoice_id', t.invoice_id, 'version', t.version, 'number', t.number, 'state', t.state, 'error', t.error,
    'tries', t.tries
  ) ORDER BY t.at, t.invoice_id::bigint), '[]'::jsonb)
  FROM (
    SELECT p.invoice_id, p.version, o.netsuite_number AS number,
           CASE WHEN p.state = 'sending' THEN 'unsure' ELSE p.state END AS state,
           CASE WHEN p.state = 'sending' THEN 'FleetSuite never heard back from NetSuite.' ELSE p.error END AS error,
           p.tries, coalesce(p.answered_at, p.started_at) AS at
    FROM public.own_invoice_pdfs p
    JOIN public.gl_own_invoices o ON o.netsuite_id = p.invoice_id AND o.version = p.version
    WHERE p.told_at IS NULL
      AND p.asked_by IS NULL
      AND (p.state = 'refused'
           OR (p.tries >= 3 AND (p.state = 'unsure'
                                 OR (p.state = 'sending' AND p.started_at <= now() - interval '15 minutes'))))
    ORDER BY coalesce(p.answered_at, p.started_at), p.invoice_id::bigint
    LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  ) t
$$;

-- Marks PDFs the daily check told about: p_keys [{ invoice_id, version }].
CREATE OR REPLACE FUNCTION public.own_invoice_pdfs_mark_told(p_keys JSONB)
RETURNS VOID
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.own_invoice_pdfs p SET told_at = now()
  FROM jsonb_to_recordset(coalesce(p_keys, '[]'::jsonb)) AS k(invoice_id TEXT, version INTEGER)
  WHERE p.invoice_id = k.invoice_id AND p.version = k.version AND p.told_at IS NULL;
$$;

-- ── Who can ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE public.own_invoice_pdfs ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.own_invoice_pdfs FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.own_invoice_pdfs_due(timestamptz, integer)', 'public.own_invoice_pdf_hold(text, integer, text)',
    'public.own_invoice_pdf_claim(text, integer, text, uuid, boolean)',
    'public.own_invoice_pdf_settle(text, integer, text, text, boolean, text)', 'public.own_invoice_pdf_state(text)',
    'public.own_invoice_pdfs_to_tell(integer)', 'public.own_invoice_pdfs_mark_told(jsonb)'
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

COMMENT ON TABLE own_invoice_pdfs IS 'Migration 498: FleetSuite''s own PDF of each version of its copy of an invoice, once Invoice PDFs is switched on: held back (its copy differs from NetSuite''s invoice, is incomplete, NetSuite voided it, or the copy of NetSuite''s invoice isn''t there yet), on its way, attached to NetSuite''s invoice with NetSuite''s id for the file, refused, or not sure (src/lib/books/invoice-pdfs.ts). Service-role write and read.';
COMMENT ON FUNCTION public.own_invoice_pdfs_due(timestamptz, integer) IS 'Migration 498: the current versions of FleetSuite''s copies made since a time whose PDF to look at next. Reads only. Service role only.';
COMMENT ON FUNCTION public.own_invoice_pdf_hold(text, integer, text) IS 'Migration 498: holds back the PDF of a copy''s current version, saying why. Service role only.';
COMMENT ON FUNCTION public.own_invoice_pdf_claim(text, integer, text, uuid, boolean) IS 'Migration 498: puts the PDF of a copy''s current version on its way to NetSuite, one at a time. Service role only.';
COMMENT ON FUNCTION public.own_invoice_pdf_settle(text, integer, text, text, boolean, text) IS 'Migration 498: says what NetSuite answered for a PDF on its way, once. Service role only.';
COMMENT ON FUNCTION public.own_invoice_pdf_state(text) IS 'Migration 498: a copy''s version and its PDFs, for the invoice''s page. Reads only. Service role only.';
COMMENT ON FUNCTION public.own_invoice_pdfs_to_tell(integer) IS 'Migration 498: the PDFs NetSuite refused, or FleetSuite is still unsure about, that the daily check hasn''t told about. Reads only. Service role only.';
COMMENT ON FUNCTION public.own_invoice_pdfs_mark_told(jsonb) IS 'Migration 498: marks PDFs the daily check told about. Service role only.';
