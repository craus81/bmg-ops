-- Migration 490: FleetSuite's own books, part 59 — vendor bank numbers kept
-- encrypted: a vendor's routing and account numbers for ACH, entered by a
-- super admin, locked with a key only the server has, and confirmed by
-- another super admin on a call-back before anything pays to them.
--
-- Owner decision 2026-10-09 (thread "Replacing NetSuite with FleetSuite"):
-- FleetSuite keeps vendor bank numbers encrypted and builds the ACH file
-- NetSuite builds today, shown masked, with a second person and a call-back
-- for a change. That ends, for vendors paid by ACH, the 2026-06-29 rule that
-- FleetSuite never keeps bank numbers (docs/cni-redesign.md); a vendor's tax
-- ID is still never kept. This is the NetSuite Exit Checklist's "Pay
-- vendors", third slice (src/lib/vendor-bank.ts, src/lib/vendor-bank-lock.ts,
-- /api/pay-vendors/bank, Vendor bank numbers on page /admin/pay-vendors,
-- docs/books.md "Vendor bank numbers kept encrypted"):
--
--   * vendor_bank_accounts, one row per set of numbers entered for a vendor.
--     The routing number, the four digits the account number ends with,
--     checking or savings and the name on the account are kept to show; the
--     numbers themselves only locked (account_locked), which only the server
--     can open, and what's locked is what's paid to. They wait for a
--     call-back (pending), and are confirmed by a super admin who didn't
--     enter them (confirmed), with the server's seal on the confirmation, so
--     a row set to confirmed by anything else doesn't hold. A vendor has one
--     set waiting and one confirmed at most, and confirming a new set
--     replaces the old one (replaced). Sets refused, by hand or after three
--     call-backs that didn't match, and sets removed are kept with why. Only
--     a set waiting or confirmed keeps its locked numbers;
--   * no note holds a run of six digits, so an account number never sits in
--     words.
--
-- Nothing pays to these numbers yet: part 60's ACH file is the first thing
-- that will, and it rides on the vendor_payments switch (migration 488).
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

CREATE TABLE IF NOT EXISTS vendor_bank_accounts (
  -- Made by the page when the form opens: the lock names it, and the same form pressed twice is one entry.
  id UUID PRIMARY KEY,
  vendor_netsuite_id TEXT NOT NULL CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  -- The vendor's name when they were entered.
  vendor_name TEXT CHECK (length(vendor_name) <= 200),
  -- Kept to show; what's paid to is what's locked.
  routing_number TEXT NOT NULL CHECK (routing_number ~ '^[0-9]{9}$'),
  account_last4 TEXT NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  account_type TEXT NOT NULL CHECK (account_type IN ('checking', 'savings')),
  -- As the ACH file has it, 22 characters at most.
  name_on_account TEXT NOT NULL CHECK (btrim(name_on_account) <> '' AND length(name_on_account) <= 22),
  -- Where the numbers came from: whose form, and how it reached BMG.
  source TEXT NOT NULL CHECK (btrim(source) <> '' AND length(source) <= 300 AND source !~ '[0-9]{6}'),
  -- The numbers, locked by src/lib/vendor-bank-lock.ts: 'v1.<key id>.<iv>.<tag>.<locked>'.
  account_locked TEXT CHECK (account_locked ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{40,255}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'replaced', 'refused', 'removed')),
  -- Call-backs that didn't match: the third refuses them.
  tries INTEGER NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 3),
  entered_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The call-back: who confirmed them, the number they called, and who read the numbers out.
  confirmed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  called_phone TEXT CHECK (btrim(called_phone) <> '' AND length(called_phone) <= 40),
  spoke_with TEXT CHECK (btrim(spoke_with) <> '' AND length(spoke_with) <= 100 AND spoke_with !~ '[0-9]{6}'),
  -- The server's seal on the confirmation: '<key id>.<HMAC>'.
  confirm_seal TEXT CHECK (confirm_seal ~ '^[0-9a-f]{8}\.[A-Za-z0-9_-]{43}$'),
  -- How it ended: replaced, refused or removed, by whom and, refused or removed, why.
  ended_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ended_at TIMESTAMPTZ,
  ended_why TEXT CHECK (btrim(ended_why) <> '' AND length(ended_why) <= 300 AND ended_why !~ '[0-9]{6}'),
  CONSTRAINT vendor_bank_locked_while_live CHECK ((account_locked IS NOT NULL) = (status IN ('pending', 'confirmed'))),
  CONSTRAINT vendor_bank_sealed_while_confirmed CHECK ((confirm_seal IS NOT NULL) = (status = 'confirmed')),
  CONSTRAINT vendor_bank_called_back CHECK (status IN ('pending', 'refused') OR (confirmed_at IS NOT NULL AND called_phone IS NOT NULL AND spoke_with IS NOT NULL)),
  CONSTRAINT vendor_bank_ended CHECK ((ended_at IS NOT NULL) = (status IN ('replaced', 'refused', 'removed'))
                                      AND (status NOT IN ('refused', 'removed') OR ended_why IS NOT NULL)),
  -- Whoever entered them never confirms them.
  CONSTRAINT vendor_bank_second_person CHECK (confirmed_by IS NULL OR entered_by IS NULL OR confirmed_by <> entered_by)
);
-- One set waiting and one confirmed at most for each vendor.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_bank_one_pending ON vendor_bank_accounts (vendor_netsuite_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS vendor_bank_one_confirmed ON vendor_bank_accounts (vendor_netsuite_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS vendor_bank_ended_idx ON vendor_bank_accounts (ended_at DESC, id) WHERE ended_at IS NOT NULL;

-- A set of numbers entered for a vendor, waiting for a call-back. p:
--   { id, vendor_netsuite_id, vendor_name?, routing_number, account_last4, account_type, name_on_account, source,
--     account_locked, by? }
-- Answers { state: 'entered', fresh: true }; { state: 'entered', fresh: false } when this press entered them already;
-- { state: 'taken' } when its id is another vendor's; or { state: 'waiting' } when the vendor has a set waiting for a
-- call-back already, which is confirmed or refused first.
CREATE OR REPLACE FUNCTION public.vendor_bank_enter(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_vendor TEXT := p->>'vendor_netsuite_id';
  v_had TEXT;
BEGIN
  SELECT vendor_netsuite_id INTO v_had FROM public.vendor_bank_accounts WHERE id = v_id;
  IF FOUND THEN
    RETURN CASE WHEN v_had = v_vendor THEN jsonb_build_object('state', 'entered', 'fresh', false) ELSE jsonb_build_object('state', 'taken') END;
  END IF;
  BEGIN
    INSERT INTO public.vendor_bank_accounts
      (id, vendor_netsuite_id, vendor_name, routing_number, account_last4, account_type, name_on_account, source, account_locked, entered_by)
    VALUES
      (v_id, v_vendor, NULLIF(btrim(p->>'vendor_name'), ''), p->>'routing_number', p->>'account_last4', p->>'account_type',
       btrim(p->>'name_on_account'), btrim(p->>'source'), p->>'account_locked', NULLIF(p->>'by', '')::uuid);
  EXCEPTION WHEN unique_violation THEN
    -- The same press at the same moment, or another set waiting for the vendor.
    SELECT vendor_netsuite_id INTO v_had FROM public.vendor_bank_accounts WHERE id = v_id;
    IF FOUND THEN
      RETURN CASE WHEN v_had = v_vendor THEN jsonb_build_object('state', 'entered', 'fresh', false) ELSE jsonb_build_object('state', 'taken') END;
    END IF;
    RETURN jsonb_build_object('state', 'waiting');
  END;
  RETURN jsonb_build_object('state', 'entered', 'fresh', true);
END
$$;

-- A call-back that read numbers other than the ones waiting. p: { id, by }
-- Answers { state: 'tried', tries }, or { state: 'refused', tries: 3 } on the third, which refuses them; 'same_person'
-- when it's whoever entered them; or where they are: 'gone', 'confirmed', 'replaced', 'refused' or 'removed'.
CREATE OR REPLACE FUNCTION public.vendor_bank_mismatch(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_bank_accounts;
  v_by UUID := NULLIF(p->>'by', '')::uuid;
BEGIN
  SELECT * INTO v_row FROM public.vendor_bank_accounts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'gone'); END IF;
  IF v_row.status <> 'pending' THEN RETURN jsonb_build_object('state', v_row.status); END IF;
  IF v_by IS NULL OR v_by = v_row.entered_by THEN RETURN jsonb_build_object('state', 'same_person'); END IF;
  IF v_row.tries >= 2 THEN
    UPDATE public.vendor_bank_accounts
    SET tries = 3, status = 'refused', account_locked = NULL, ended_by = v_by, ended_at = now(),
        ended_why = 'The numbers read on three call-backs didn''t match what was entered.'
    WHERE id = v_row.id;
    RETURN jsonb_build_object('state', 'refused', 'tries', 3);
  END IF;
  UPDATE public.vendor_bank_accounts SET tries = v_row.tries + 1 WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'tried', 'tries', v_row.tries + 1);
END
$$;

-- Numbers waiting, confirmed on a call-back by a super admin who didn't enter them, with the server's seal on it; the
-- vendor's confirmed numbers before, if any, are replaced. p: { id, by, called_phone, spoke_with, confirm_seal }
-- Answers { state: 'confirmed', replaced: <id or null> }; 'same_person' when it's whoever entered them; or where
-- they are: 'gone', 'confirmed', 'replaced', 'refused' or 'removed'.
CREATE OR REPLACE FUNCTION public.vendor_bank_confirm(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_bank_accounts;
  v_by UUID := NULLIF(p->>'by', '')::uuid;
  v_replaced UUID;
BEGIN
  SELECT * INTO v_row FROM public.vendor_bank_accounts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'gone'); END IF;
  IF v_row.status <> 'pending' THEN RETURN jsonb_build_object('state', v_row.status); END IF;
  IF v_by IS NULL OR v_by = v_row.entered_by THEN RETURN jsonb_build_object('state', 'same_person'); END IF;

  UPDATE public.vendor_bank_accounts
  SET status = 'replaced', account_locked = NULL, confirm_seal = NULL, ended_by = v_by, ended_at = now()
  WHERE vendor_netsuite_id = v_row.vendor_netsuite_id AND status = 'confirmed'
  RETURNING id INTO v_replaced;

  UPDATE public.vendor_bank_accounts
  SET status = 'confirmed', confirmed_by = v_by, confirmed_at = now(), called_phone = btrim(p->>'called_phone'),
      spoke_with = btrim(p->>'spoke_with'), confirm_seal = p->>'confirm_seal'
  WHERE id = v_row.id;
  RETURN jsonb_build_object('state', 'confirmed', 'replaced', v_replaced);
END
$$;

-- Numbers waiting refused, or numbers confirmed removed, with why: their locked numbers go.
-- p: { id, by, status: 'refused' | 'removed', why }
-- Answers { state: 'refused' } or { state: 'removed' }; or where they are, when they aren't waiting (to refuse) or
-- confirmed (to remove): 'gone', 'pending', 'confirmed', 'replaced', 'refused' or 'removed'.
CREATE OR REPLACE FUNCTION public.vendor_bank_end(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.vendor_bank_accounts;
  v_to TEXT := p->>'status';
BEGIN
  IF v_to IS NULL OR v_to NOT IN ('refused', 'removed') THEN
    RAISE EXCEPTION 'vendor_bank_end refuses or removes, not %', coalesce(v_to, 'nothing');
  END IF;
  SELECT * INTO v_row FROM public.vendor_bank_accounts WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'gone'); END IF;
  IF v_row.status <> (CASE v_to WHEN 'refused' THEN 'pending' ELSE 'confirmed' END) THEN
    RETURN jsonb_build_object('state', v_row.status);
  END IF;
  UPDATE public.vendor_bank_accounts
  SET status = v_to, account_locked = NULL, confirm_seal = NULL, ended_by = NULLIF(p->>'by', '')::uuid, ended_at = now(),
      ended_why = btrim(p->>'why')
  WHERE id = v_row.id;
  RETURN jsonb_build_object('state', v_to);
END
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE public.vendor_bank_accounts ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.vendor_bank_accounts FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.vendor_bank_enter(jsonb)', 'public.vendor_bank_mismatch(jsonb)', 'public.vendor_bank_confirm(jsonb)',
                           'public.vendor_bank_end(jsonb)'] LOOP
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

COMMENT ON TABLE vendor_bank_accounts IS 'Migration 490: vendor bank numbers for ACH (src/lib/vendor-bank.ts, /api/pay-vendors/bank), one row per set entered: the routing number, the account number''s last four digits, checking or savings and the name on the account kept to show, the numbers themselves only locked with a key only the server has (src/lib/vendor-bank-lock.ts). Waiting for a call-back, confirmed by a super admin who didn''t enter them (sealed by the server), replaced, refused (by hand or after three call-backs that didn''t match) or removed; only a set waiting or confirmed keeps its locked numbers, one of each per vendor. No note holds a run of six digits. Moved only by its functions. Service-role write and read.';
COMMENT ON FUNCTION public.vendor_bank_enter(jsonb) IS 'Migration 490: a vendor''s bank numbers entered, locked, waiting for a call-back; once per press, and not while the vendor has a set waiting. Service role only.';
COMMENT ON FUNCTION public.vendor_bank_mismatch(jsonb) IS 'Migration 490: a call-back that read other numbers than the ones waiting; the third refuses them. Service role only.';
COMMENT ON FUNCTION public.vendor_bank_confirm(jsonb) IS 'Migration 490: numbers waiting confirmed on a call-back by a super admin who didn''t enter them, sealed by the server; the vendor''s confirmed numbers before are replaced. Service role only.';
COMMENT ON FUNCTION public.vendor_bank_end(jsonb) IS 'Migration 490: numbers waiting refused, or confirmed removed, with why; their locked numbers go. Service role only.';
