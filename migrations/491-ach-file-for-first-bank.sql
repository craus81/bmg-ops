-- Migration 491: FleetSuite's own books, part 60 — the ACH file for First
-- Bank: a payment run's ACH payments, made in NetSuite as bill payments,
-- paid to each vendor's bank numbers confirmed on a call-back by a NACHA
-- file a super admin downloads from the run and uploads to First Bank.
--
-- Owner decisions (thread "Replacing NetSuite with FleetSuite"): FleetSuite
-- keeps vendor bank numbers encrypted and builds the ACH file NetSuite builds
-- today (2026-10-09); paying vendors moves into FleetSuite during 2027
-- (2026-10-31). This is the NetSuite Exit Checklist's "Pay vendors", fourth
-- slice (src/lib/ach-file.ts, /api/pay-vendors/ach, a run's ACH file on page
-- /admin/pay-vendors, docs/books.md "The ACH file for First Bank"):
--
--   * vendor_ach_setups, one row per bank account: how its ACH file starts,
--     as First Bank set BMG up to send it (First Bank's routing number,
--     BMG's ID with First Bank and its company ID, the names and the entry
--     description, CCD or PPD, addenda or not, how lines end), and whether
--     First Bank wants the offsetting debit to BMG's account in the file
--     (balanced). That account is shown as its routing number, last four
--     digits and type, and kept only locked, as vendors' numbers are;
--   * vendor_ach_files, one row per file made from a run: where it goes, the
--     day and time it was made and the letter or digit that tells it apart
--     from the other files made that day for First Bank from BMG, the day
--     First Bank pays it, what it pays and its entry hash. The file itself
--     is kept locked only while it waits to be uploaded (made). Then it's
--     marked sent to First Bank, or set aside with why (First Bank refused
--     it, or it was never sent), and its locked copy goes;
--   * vendor_ach_file_payments, the payments in each file and the vendor's
--     numbers each pays to, as shown. A payment is in one file at a time
--     that isn't set aside, so it's never paid twice from FleetSuite; one in
--     a file set aside can go in a new file.
--
-- It rides on the vendor_payments switch (migration 488): no run is
-- approved while that's off, so no ACH payment is made and no file is.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── How each bank account's file starts ───────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_ach_setups (
  -- The bank account the payments come from, by NetSuite's id.
  bank_account_netsuite_id TEXT PRIMARY KEY CHECK (bank_account_netsuite_id ~ '^[0-9]+$'),
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  -- First Bank's routing number, where the file goes (immediate destination), and its name.
  destination TEXT NOT NULL CHECK (destination ~ '^[0-9]{9}$'),
  destination_name TEXT NOT NULL CHECK (destination_name ~ '^[A-Z0-9 &'',./#-]{1,23}$' AND destination_name = btrim(destination_name)),
  -- BMG as First Bank knows it (immediate origin): 10 characters, or 9 digits the file sends after a space.
  origin TEXT NOT NULL CHECK (origin ~ '^([A-Z0-9]{10}|[0-9]{9})$'),
  origin_name TEXT NOT NULL CHECK (origin_name ~ '^[A-Z0-9 &'',./#-]{1,23}$' AND origin_name = btrim(origin_name)),
  -- The first 8 digits of the routing number of the bank sending the payments.
  odfi TEXT NOT NULL CHECK (odfi ~ '^[0-9]{8}$'),
  company_name TEXT NOT NULL CHECK (company_name ~ '^[A-Z0-9 &'',./#-]{1,16}$' AND company_name = btrim(company_name)),
  company_id TEXT NOT NULL CHECK (company_id ~ '^[A-Z0-9]{1,10}$'),
  entry_description TEXT NOT NULL CHECK (entry_description ~ '^[A-Z0-9 &'',./#-]{1,10}$' AND entry_description = btrim(entry_description)),
  sec_code TEXT NOT NULL CHECK (sec_code IN ('CCD', 'PPD')),
  addenda BOOLEAN NOT NULL,
  balanced BOOLEAN NOT NULL,
  line_ending TEXT NOT NULL CHECK (line_ending IN ('crlf', 'lf')),
  -- BMG's account for the offsetting debit in a balanced file, kept to show; what's debited is what's locked
  -- (src/lib/vendor-bank-lock.ts, locked to this bank account).
  offset_routing TEXT CHECK (offset_routing ~ '^[0-9]{9}$'),
  offset_last4 TEXT CHECK (offset_last4 ~ '^[0-9]{4}$'),
  offset_type TEXT CHECK (offset_type IN ('checking', 'savings')),
  offset_locked TEXT CHECK (offset_locked ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{40,255}$'),
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vendor_ach_offset_when_balanced CHECK (
    CASE WHEN balanced
      THEN offset_routing IS NOT NULL AND offset_last4 IS NOT NULL AND offset_type IS NOT NULL AND offset_locked IS NOT NULL
      ELSE offset_routing IS NULL AND offset_last4 IS NULL AND offset_type IS NULL AND offset_locked IS NULL
    END)
);

-- ── The files ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_ach_files (
  -- Made by the server: the lock on the file names it.
  id UUID PRIMARY KEY,
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  bank_account_netsuite_id TEXT NOT NULL CHECK (bank_account_netsuite_id ~ '^[0-9]+$'),
  run_id UUID NOT NULL REFERENCES vendor_payment_runs(id) ON DELETE RESTRICT,
  -- Where it goes and who it's from, as its header has them.
  destination TEXT NOT NULL CHECK (destination ~ '^[0-9]{9}$'),
  origin TEXT NOT NULL CHECK (origin ~ '^([A-Z0-9]{10}|[0-9]{9})$'),
  -- When it was made at BMG (Central time), and the letter or digit for it that day.
  created_on DATE NOT NULL,
  created_time TEXT NOT NULL CHECK (created_time ~ '^([01][0-9]|2[0-3])[0-5][0-9]$'),
  modifier TEXT NOT NULL CHECK (modifier ~ '^[A-Z0-9]$'),
  -- The day First Bank pays it: never before the day it's made.
  effective_date DATE NOT NULL,
  -- Its payments, what they come to, and its entry hash, the offsetting debit not counted in the first two.
  entry_count INTEGER NOT NULL CHECK (entry_count BETWEEN 1 AND 50),
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
  entry_hash TEXT NOT NULL CHECK (entry_hash ~ '^[0-9]{10}$'),
  file_name TEXT NOT NULL CHECK (file_name ~ '^[A-Za-z0-9-]{1,96}\.txt$'),
  -- The file, locked to this row, while it waits to be uploaded.
  file_locked TEXT CHECK (file_locked ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$' AND length(file_locked) <= 60000),
  status TEXT NOT NULL DEFAULT 'made' CHECK (status IN ('made', 'sent', 'set_aside')),
  made_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- How often it's been downloaded, and the last time.
  downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  downloaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  downloaded_at TIMESTAMPTZ,
  -- Uploaded to First Bank.
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  -- Set aside, and why: First Bank refused it, or it was never sent. Its payments can go in a new file.
  set_aside_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  set_aside_at TIMESTAMPTZ,
  set_aside_why TEXT CHECK (btrim(set_aside_why) <> '' AND length(set_aside_why) <= 300 AND set_aside_why !~ '[0-9]{6}'),
  CONSTRAINT vendor_ach_file_locked_while_made CHECK ((file_locked IS NOT NULL) = (status = 'made')),
  CONSTRAINT vendor_ach_file_sent CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  CONSTRAINT vendor_ach_file_fresh CHECK (status <> 'made' OR (sent_at IS NULL AND set_aside_at IS NULL)),
  CONSTRAINT vendor_ach_file_set_aside CHECK ((status = 'set_aside') = (set_aside_at IS NOT NULL AND set_aside_why IS NOT NULL)),
  CONSTRAINT vendor_ach_file_downloaded CHECK (downloads = 0 OR downloaded_at IS NOT NULL),
  CONSTRAINT vendor_ach_file_paid_after_made CHECK (effective_date >= created_on),
  -- No two files made the same day for the same bank from BMG share a letter.
  CONSTRAINT vendor_ach_files_one_modifier UNIQUE (destination, origin, created_on, modifier)
);
CREATE INDEX IF NOT EXISTS vendor_ach_files_run_idx ON vendor_ach_files (run_id, made_at, id);

CREATE TABLE IF NOT EXISTS vendor_ach_file_payments (
  file_id UUID NOT NULL REFERENCES vendor_ach_files(id) ON DELETE RESTRICT,
  payment_id UUID NOT NULL REFERENCES vendor_payment_run_payments(id) ON DELETE RESTRICT,
  -- Its place in the file, from 1: its entry's sequence number.
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 50),
  vendor_netsuite_id TEXT NOT NULL CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT CHECK (length(vendor_name) <= 300),
  -- The vendor's numbers it pays to, confirmed on a call-back (migration 490), as shown.
  bank_account_id UUID NOT NULL REFERENCES vendor_bank_accounts(id) ON DELETE RESTRICT,
  routing_number TEXT NOT NULL CHECK (routing_number ~ '^[0-9]{9}$'),
  account_last4 TEXT NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  account_type TEXT NOT NULL CHECK (account_type IN ('checking', 'savings')),
  name_on_account TEXT NOT NULL CHECK (btrim(name_on_account) <> '' AND length(name_on_account) <= 22),
  cents BIGINT NOT NULL CHECK (cents > 0),
  -- In a file made or sent; a file set aside lets its payments go.
  live BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (file_id, payment_id),
  UNIQUE (file_id, position)
);
-- A payment is in one file at a time that isn't set aside.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_ach_payment_once ON vendor_ach_file_payments (payment_id) WHERE live;

-- A file made from a run's ACH payments, made in NetSuite, each to its vendor's numbers confirmed on a call-back.
-- p: { id, company, bank_account_netsuite_id, run_id, destination, origin, created_on, created_time, modifier,
--      effective_date, entry_count, total_cents, entry_hash, file_name, file_locked, by,
--      payments: [{ payment_id, vendor_netsuite_id, vendor_name, bank_account_id, routing_number, account_last4,
--                   account_type, name_on_account, cents }], in the file's order }
-- Answers { state: 'made' }; { state: 'made_already' } when this id was made already; { state: 'modifier_taken' }
-- when another file that day for the bank from BMG has its letter, to make it again with the next; { state: 'run' }
-- when the run isn't approved or paid, or pays from another account; { state: 'totals' } when its count or total
-- isn't its payments'; or { state: 'payment', payment_id, why } when a payment can't go in: 'not_ach' (not this run's
-- or not by ACH), 'not_made' (its bill payment isn't made in NetSuite), 'cents' (it isn't what the payment pays),
-- 'in_file' (it's in another file not set aside) or 'bank' (those aren't the vendor's numbers confirmed now).
CREATE OR REPLACE FUNCTION public.vendor_ach_file_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_run public.vendor_payment_runs;
  v_pay public.vendor_payment_run_payments;
  v_bank public.vendor_bank_accounts;
  v_item JSONB;
  v_count INTEGER := 0;
  v_total BIGINT := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.vendor_ach_files WHERE id = (p->>'id')::uuid) THEN
    RETURN jsonb_build_object('state', 'made_already');
  END IF;
  -- One file made at a time from a run.
  SELECT * INTO v_run FROM public.vendor_payment_runs WHERE id = (p->>'run_id')::uuid FOR UPDATE;
  IF NOT FOUND OR v_run.status NOT IN ('approved', 'done') OR v_run.bank_account_netsuite_id IS DISTINCT FROM p->>'bank_account_netsuite_id'
     OR v_run.company IS DISTINCT FROM p->>'company' THEN
    RETURN jsonb_build_object('state', 'run');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'payments') = 'array' THEN p->'payments' ELSE '[]'::jsonb END) LOOP
    SELECT * INTO v_pay FROM public.vendor_payment_run_payments WHERE id = (v_item->>'payment_id')::uuid FOR UPDATE;
    IF NOT FOUND OR v_pay.run_id <> v_run.id OR v_pay.method <> 'ach' OR v_pay.vendor_netsuite_id IS DISTINCT FROM v_item->>'vendor_netsuite_id' THEN
      RETURN jsonb_build_object('state', 'payment', 'payment_id', v_item->>'payment_id', 'why', 'not_ach');
    END IF;
    IF v_pay.status <> 'made' THEN
      RETURN jsonb_build_object('state', 'payment', 'payment_id', v_pay.id, 'why', 'not_made');
    END IF;
    IF v_pay.total_cents IS DISTINCT FROM (v_item->>'cents')::bigint THEN
      RETURN jsonb_build_object('state', 'payment', 'payment_id', v_pay.id, 'why', 'cents');
    END IF;
    IF EXISTS (SELECT 1 FROM public.vendor_ach_file_payments WHERE payment_id = v_pay.id AND live) THEN
      RETURN jsonb_build_object('state', 'payment', 'payment_id', v_pay.id, 'why', 'in_file');
    END IF;
    SELECT * INTO v_bank FROM public.vendor_bank_accounts WHERE id = (v_item->>'bank_account_id')::uuid FOR SHARE;
    IF NOT FOUND OR v_bank.status <> 'confirmed' OR v_bank.vendor_netsuite_id <> v_pay.vendor_netsuite_id
       OR v_bank.routing_number IS DISTINCT FROM v_item->>'routing_number' OR v_bank.account_last4 IS DISTINCT FROM v_item->>'account_last4'
       OR v_bank.account_type IS DISTINCT FROM v_item->>'account_type' OR v_bank.name_on_account IS DISTINCT FROM v_item->>'name_on_account' THEN
      RETURN jsonb_build_object('state', 'payment', 'payment_id', v_pay.id, 'why', 'bank');
    END IF;
    v_count := v_count + 1;
    v_total := v_total + v_pay.total_cents;
  END LOOP;
  IF v_count = 0 OR v_count IS DISTINCT FROM (p->>'entry_count')::integer OR v_total IS DISTINCT FROM (p->>'total_cents')::bigint THEN
    RETURN jsonb_build_object('state', 'totals');
  END IF;

  BEGIN
    INSERT INTO public.vendor_ach_files
      (id, company, bank_account_netsuite_id, run_id, destination, origin, created_on, created_time, modifier, effective_date,
       entry_count, total_cents, entry_hash, file_name, file_locked, made_by)
    VALUES
      ((p->>'id')::uuid, p->>'company', p->>'bank_account_netsuite_id', v_run.id, p->>'destination', p->>'origin',
       (p->>'created_on')::date, p->>'created_time', p->>'modifier', (p->>'effective_date')::date, v_count, v_total,
       p->>'entry_hash', p->>'file_name', p->>'file_locked', NULLIF(p->>'by', '')::uuid);
  EXCEPTION WHEN unique_violation THEN
    -- Its id was taken the same moment, or another file has its letter for the day.
    IF EXISTS (SELECT 1 FROM public.vendor_ach_files WHERE id = (p->>'id')::uuid) THEN
      RETURN jsonb_build_object('state', 'made_already');
    END IF;
    RETURN jsonb_build_object('state', 'modifier_taken');
  END;
  INSERT INTO public.vendor_ach_file_payments
    (file_id, payment_id, position, vendor_netsuite_id, vendor_name, bank_account_id, routing_number, account_last4, account_type,
     name_on_account, cents)
  SELECT (p->>'id')::uuid, (x.i->>'payment_id')::uuid, x.n, x.i->>'vendor_netsuite_id', NULLIF(btrim(x.i->>'vendor_name'), ''),
         (x.i->>'bank_account_id')::uuid, x.i->>'routing_number', x.i->>'account_last4', x.i->>'account_type', x.i->>'name_on_account',
         (x.i->>'cents')::bigint
  FROM jsonb_array_elements(p->'payments') WITH ORDINALITY AS x(i, n);
  RETURN jsonb_build_object('state', 'made');
END
$$;

-- A file made, downloaded to upload to First Bank: counted, as long as each vendor's numbers it pays to are still
-- the ones confirmed. p: { id, by }
-- Answers { state: 'downloaded', downloads }; { state: 'bank', vendor_name } when a vendor's numbers were replaced
-- or removed since it was made, so it's set aside and made again; or where it is: 'gone', 'sent' or 'set_aside'.
CREATE OR REPLACE FUNCTION public.vendor_ach_file_downloaded(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_file public.vendor_ach_files;
  v_vendor TEXT;
BEGIN
  SELECT * INTO v_file FROM public.vendor_ach_files WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'gone'); END IF;
  IF v_file.status <> 'made' THEN RETURN jsonb_build_object('state', v_file.status); END IF;
  SELECT coalesce(fp.vendor_name, 'Vendor ' || fp.vendor_netsuite_id) INTO v_vendor
  FROM public.vendor_ach_file_payments fp
  JOIN public.vendor_bank_accounts b ON b.id = fp.bank_account_id
  WHERE fp.file_id = v_file.id AND b.status <> 'confirmed'
  ORDER BY fp.position
  LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('state', 'bank', 'vendor_name', v_vendor); END IF;
  UPDATE public.vendor_ach_files
  SET downloads = downloads + 1, downloaded_by = NULLIF(p->>'by', '')::uuid, downloaded_at = now()
  WHERE id = v_file.id;
  RETURN jsonb_build_object('state', 'downloaded', 'downloads', v_file.downloads + 1);
END
$$;

-- A file made, uploaded to First Bank: its locked copy goes. p: { id, by }
-- Answers { state: 'sent' }; { state: 'sent_already' } when it was marked sent before; or 'gone' or 'set_aside'.
CREATE OR REPLACE FUNCTION public.vendor_ach_file_sent(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_file public.vendor_ach_files;
BEGIN
  SELECT * INTO v_file FROM public.vendor_ach_files WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'gone'); END IF;
  IF v_file.status = 'sent' THEN RETURN jsonb_build_object('state', 'sent_already'); END IF;
  IF v_file.status <> 'made' THEN RETURN jsonb_build_object('state', v_file.status); END IF;
  UPDATE public.vendor_ach_files
  SET status = 'sent', sent_by = NULLIF(p->>'by', '')::uuid, sent_at = now(), file_locked = NULL
  WHERE id = v_file.id;
  RETURN jsonb_build_object('state', 'sent');
END
$$;

-- A file made or sent, set aside with why (First Bank refused it, or it was never sent): its locked copy goes, and its
-- payments can go in a new file. p: { id, by, why }
-- Answers { state: 'set_aside', was: 'made' | 'sent' }; { state: 'set_aside_already' }; or 'gone'.
CREATE OR REPLACE FUNCTION public.vendor_ach_file_set_aside(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_file public.vendor_ach_files;
BEGIN
  SELECT * INTO v_file FROM public.vendor_ach_files WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'gone'); END IF;
  IF v_file.status = 'set_aside' THEN RETURN jsonb_build_object('state', 'set_aside_already'); END IF;
  UPDATE public.vendor_ach_files
  SET status = 'set_aside', set_aside_by = NULLIF(p->>'by', '')::uuid, set_aside_at = now(), set_aside_why = btrim(p->>'why'),
      file_locked = NULL
  WHERE id = v_file.id;
  UPDATE public.vendor_ach_file_payments SET live = false WHERE file_id = v_file.id AND live;
  RETURN jsonb_build_object('state', 'set_aside', 'was', v_file.status);
END
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.vendor_ach_setups', 'public.vendor_ach_files', 'public.vendor_ach_file_payments'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.vendor_ach_file_save(jsonb)', 'public.vendor_ach_file_downloaded(jsonb)', 'public.vendor_ach_file_sent(jsonb)',
                           'public.vendor_ach_file_set_aside(jsonb)'] LOOP
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

COMMENT ON TABLE vendor_ach_setups IS 'Migration 491: how each bank account''s ACH file for First Bank starts (src/lib/ach-file.ts, /api/pay-vendors/ach): First Bank''s routing number and name, BMG''s ID with First Bank, names and company ID, the entry description, CCD or PPD, addenda or not, how lines end, and whether First Bank wants the offsetting debit to BMG''s account in the file; that account shown as routing number, last four digits and type, kept only locked. Service-role write and read.';
COMMENT ON TABLE vendor_ach_files IS 'Migration 491: each ACH file made from a payment run for First Bank: where it goes, when it was made and its letter for the day, the day First Bank pays it, what it pays and its entry hash; the file kept locked only while it waits to be uploaded (made), then sent to First Bank, or set aside with why. Moved only by its functions. Service-role write and read.';
COMMENT ON TABLE vendor_ach_file_payments IS 'Migration 491: the payments in each ACH file and the vendor''s numbers confirmed on a call-back each pays to, as shown (routing number, last four digits, type, name on the account). A payment is in one file at a time that isn''t set aside. Service-role write and read.';
COMMENT ON FUNCTION public.vendor_ach_file_save(jsonb) IS 'Migration 491: an ACH file made from a run''s ACH payments made in NetSuite, each to its vendor''s numbers confirmed now, no payment in another file not set aside, its letter for the day its own. Service role only.';
COMMENT ON FUNCTION public.vendor_ach_file_downloaded(jsonb) IS 'Migration 491: an ACH file made, downloaded, while each vendor''s numbers it pays to are still the ones confirmed. Service role only.';
COMMENT ON FUNCTION public.vendor_ach_file_sent(jsonb) IS 'Migration 491: an ACH file made, uploaded to First Bank; its locked copy goes. Service role only.';
COMMENT ON FUNCTION public.vendor_ach_file_set_aside(jsonb) IS 'Migration 491: an ACH file made or sent, set aside with why; its locked copy goes and its payments can go in a new file. Service role only.';
