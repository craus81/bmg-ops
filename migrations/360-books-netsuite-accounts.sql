-- Migration 360: FleetSuite's own books, part 2 — the chart of accounts
-- follows NetSuite's until the changeover.
--
-- Owner decision 2026-10-10 (thread "Replacing NetSuite with FleetSuite"):
-- take the accounts from NetSuite and keep them in step until the
-- changeover. Until then NetSuite is the only place an account is added or
-- changed, and FleetSuite never writes one back. Every two hours the
-- ledger mirror cron reads NetSuite's account list and hands it to
-- gl_sync_netsuite_accounts(), which applies it in one transaction, matched
-- on NetSuite's internal id (gl_accounts.netsuite_account_id):
--   * a new NetSuite account is added; renames, number changes, parents,
--     inactive flags and which company may use it follow NetSuite
--   * a type or company change on an account the journal has already posted
--     to is not applied (the postings stay meaningful); it is kept in
--     sync_issue and reported instead
--   * an account that disappears from a complete list is marked inactive,
--     unless the list looks cut short (empty, or under half of what's here)
--
-- NetSuite's summary accounts (headings over other accounts) come across so
-- the hierarchy holds, and the journal refuses postings to them as NetSuite
-- does.

ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS is_summary BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS netsuite_type TEXT;
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS netsuite_subsidiary_ids TEXT[];
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS sync_issue TEXT;
CREATE INDEX IF NOT EXISTS idx_gl_accounts_parent ON gl_accounts(parent_id);

-- Migration 359's line check, plus: a summary account takes no postings.
CREATE OR REPLACE FUNCTION public.gl_lines_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_entry public.gl_entries%ROWTYPE;
  v_account public.gl_accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM public.gl_entries WHERE id = NEW.entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: line for unknown entry %', NEW.entry_id;
  END IF;
  IF v_entry.posted_txid <> txid_current() THEN
    RAISE EXCEPTION 'gl: entry % is already posted; lines can only be added while it is being posted', v_entry.entry_no;
  END IF;

  SELECT * INTO v_account FROM public.gl_accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: unknown account %', NEW.account_id;
  END IF;
  -- A reversal may hit an account deactivated since the original posted.
  IF NOT v_account.active AND v_entry.reverses_entry_id IS NULL THEN
    RAISE EXCEPTION 'gl: account % (%) is inactive', v_account.number, v_account.name;
  END IF;
  IF v_account.is_summary AND v_entry.reverses_entry_id IS NULL THEN
    RAISE EXCEPTION 'gl: account % (%) is a heading; post to an account under it', v_account.number, v_account.name;
  END IF;
  IF v_account.company_id IS NOT NULL AND v_account.company_id <> v_entry.company_id THEN
    RAISE EXCEPTION 'gl: account % (%) belongs to another company', v_account.number, v_account.name;
  END IF;
  IF v_account.is_control AND v_entry.source_type = 'manual' THEN
    RAISE EXCEPTION 'gl: account % (%) is posted only by its own documents, not by a typed entry', v_account.number, v_account.name;
  END IF;

  NEW.company_id := v_entry.company_id;
  NEW.entry_date := v_entry.entry_date;
  RETURN NEW;
END;
$$;

-- Applies NetSuite's account list. p:
--   { complete: true when this is the whole list,
--     company_subsidiaries?: [{ company: '1084', subsidiary_id: '5' }],
--     accounts: [{ netsuite_id, number?, name, account_type (gl_accounts'
--       type, already mapped), netsuite_type, parent_netsuite_id?, active,
--       summary, description?, company? ('BMG' | '1084' | null = any),
--       subsidiary_ids? }] }
-- An account sent without company and subsidiary_ids (NetSuite wouldn't
-- say which subsidiaries it's limited to) keeps what it had.
-- company_subsidiaries links a company to its NetSuite subsidiary the first
-- time it's found; an existing link never changes here. Returns counts and
-- the issues found.
CREATE OR REPLACE FUNCTION public.gl_sync_netsuite_accounts(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row JSONB;
  v_ns TEXT;
  v_old public.gl_accounts%ROWTYPE;
  v_number TEXT;
  v_name TEXT;
  v_type TEXT;
  v_company UUID;
  v_summary BOOLEAN;
  v_active BOOLEAN;
  v_description TEXT;
  v_subs TEXT[];
  v_control BOOLEAN;
  v_issue TEXT;
  v_seen TEXT[] := '{}';
  v_added_ids TEXT[] := '{}';
  v_changed_ids TEXT[] := '{}';
  v_parent_ids TEXT[];
  v_total INTEGER;
  v_synced_active INTEGER;
  v_gone INTEGER := 0;
  v_issues JSONB := '[]'::jsonb;
BEGIN
  -- One sync at a time: the cron and "Sync now" can land together, and two
  -- would race to add the same new account.
  PERFORM pg_advisory_xact_lock(hashtext('gl_sync_netsuite_accounts'));

  IF jsonb_typeof(p->'accounts') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: accounts must be a list';
  END IF;
  v_total := jsonb_array_length(p->'accounts');

  IF jsonb_typeof(p->'company_subsidiaries') = 'array' THEN
    UPDATE public.gl_companies c
    SET netsuite_subsidiary_id = x.v->>'subsidiary_id'
    FROM jsonb_array_elements(p->'company_subsidiaries') AS x(v)
    WHERE c.code = x.v->>'company'
      AND c.netsuite_subsidiary_id IS NULL
      AND coalesce(x.v->>'subsidiary_id', '') ~ '^\d+$'
      AND NOT EXISTS (SELECT 1 FROM public.gl_companies o WHERE o.netsuite_subsidiary_id = x.v->>'subsidiary_id');
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p->'accounts') LOOP
    v_ns := v_row->>'netsuite_id';
    IF coalesce(v_ns, '') !~ '^\d+$' THEN
      RAISE EXCEPTION 'gl: NetSuite account id "%" isn''t a number', v_ns;
    END IF;
    IF v_ns = ANY (v_seen) THEN
      RAISE EXCEPTION 'gl: NetSuite account % is in the list twice', v_ns;
    END IF;
    v_seen := v_seen || v_ns;

    v_number := nullif(btrim(v_row->>'number'), '');
    v_name := nullif(btrim(v_row->>'name'), '');
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'gl: NetSuite account % has no name', v_ns;
    END IF;
    v_type := v_row->>'account_type';
    v_summary := coalesce((v_row->>'summary')::boolean, false);
    v_active := coalesce((v_row->>'active')::boolean, true);
    v_description := nullif(btrim(v_row->>'description'), '');
    v_subs := CASE WHEN jsonb_typeof(v_row->'subsidiary_ids') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(v_row->'subsidiary_ids') ORDER BY 1) END;
    v_control := v_type IN ('accounts_receivable', 'accounts_payable');
    v_company := NULL;
    IF nullif(v_row->>'company', '') IS NOT NULL THEN
      SELECT id INTO v_company FROM public.gl_companies WHERE code = v_row->>'company';
      IF v_company IS NULL THEN
        RAISE EXCEPTION 'gl: unknown company %', v_row->>'company';
      END IF;
    END IF;

    SELECT * INTO v_old FROM public.gl_accounts WHERE netsuite_account_id = v_ns FOR UPDATE;
    IF FOUND AND NOT (v_row ? 'company') AND NOT (v_row ? 'subsidiary_ids') THEN
      v_company := v_old.company_id;
      v_subs := v_old.netsuite_subsidiary_ids;
    END IF;
    IF NOT FOUND THEN
      INSERT INTO public.gl_accounts (
        number, name, account_type, company_id, is_control, is_summary, active, description,
        netsuite_account_id, netsuite_type, netsuite_subsidiary_ids
      ) VALUES (
        v_number, v_name, v_type, v_company, v_control, v_summary, v_active, v_description,
        v_ns, v_row->>'netsuite_type', v_subs
      );
      v_added_ids := v_added_ids || v_ns;
      CONTINUE;
    END IF;

    -- The journal's postings were made under the old type and company, so
    -- once there are any those two stay put and the change is reported.
    v_issue := NULL;
    IF (v_old.account_type IS DISTINCT FROM v_type OR v_old.company_id IS DISTINCT FROM v_company)
       AND EXISTS (SELECT 1 FROM public.gl_lines WHERE account_id = v_old.id) THEN
      v_issue := CASE
        WHEN v_old.account_type IS DISTINCT FROM v_type
          THEN format('NetSuite changed this account''s type to %s, but FleetSuite has postings to it as %s, so it stays %s',
                      v_type, v_old.account_type, v_old.account_type)
        ELSE 'NetSuite changed which company may use this account, but FleetSuite has postings to it, so it stays as it was'
      END;
      v_type := v_old.account_type;
      v_company := v_old.company_id;
      v_issues := v_issues || jsonb_build_object('netsuite_id', v_ns, 'number', v_number, 'name', v_name, 'issue', v_issue);
    END IF;

    UPDATE public.gl_accounts SET
      number = v_number,
      name = v_name,
      account_type = v_type,
      company_id = v_company,
      is_control = v_old.is_control OR v_control,
      is_summary = v_summary,
      active = v_active,
      description = v_description,
      netsuite_type = v_row->>'netsuite_type',
      netsuite_subsidiary_ids = v_subs,
      sync_issue = v_issue
    WHERE id = v_old.id
      AND (v_old.number, v_old.name, v_old.account_type, v_old.company_id, v_old.is_control, v_old.is_summary,
           v_old.active, v_old.description, v_old.netsuite_type, v_old.netsuite_subsidiary_ids, v_old.sync_issue)
          IS DISTINCT FROM
          (v_number, v_name, v_type, v_company, v_old.is_control OR v_control, v_summary,
           v_active, v_description, v_row->>'netsuite_type', v_subs, v_issue);
    IF FOUND THEN
      v_changed_ids := v_changed_ids || v_ns;
    END IF;
  END LOOP;

  -- Parents once every account in the list exists. A parent NetSuite didn't
  -- send (or one skipped as non-posting) leaves the account at the top.
  WITH wanted AS (
    SELECT x.v->>'netsuite_id' AS ns_id, nullif(x.v->>'parent_netsuite_id', '') AS parent_ns_id
    FROM jsonb_array_elements(p->'accounts') AS x(v)
  ), resolved AS (
    SELECT a.id, w.ns_id, par.id AS parent_id
    FROM wanted w
    JOIN public.gl_accounts a ON a.netsuite_account_id = w.ns_id
    LEFT JOIN public.gl_accounts par ON par.netsuite_account_id = w.parent_ns_id AND par.id <> a.id
  ), moved AS (
    UPDATE public.gl_accounts g SET parent_id = r.parent_id
    FROM resolved r
    WHERE g.id = r.id AND g.parent_id IS DISTINCT FROM r.parent_id
    RETURNING r.ns_id
  )
  SELECT coalesce(array_agg(ns_id), '{}') INTO v_parent_ids FROM moved;
  v_changed_ids := v_changed_ids || v_parent_ids;

  -- NetSuite only deletes accounts nothing ever posted to; one that's gone
  -- from a complete list is kept here, inactive.
  IF coalesce((p->>'complete')::boolean, false) THEN
    SELECT count(*) INTO v_synced_active FROM public.gl_accounts WHERE netsuite_account_id IS NOT NULL AND active;
    IF v_total = 0 OR v_total * 2 < v_synced_active THEN
      v_issues := v_issues || jsonb_build_object('issue',
        format('NetSuite sent %s accounts and FleetSuite has %s active, so none were marked gone', v_total, v_synced_active));
    ELSE
      UPDATE public.gl_accounts SET active = false, sync_issue = 'No longer in NetSuite'
      WHERE netsuite_account_id IS NOT NULL
        AND NOT (netsuite_account_id = ANY (v_seen))
        AND (active OR sync_issue IS DISTINCT FROM 'No longer in NetSuite');
      GET DIAGNOSTICS v_gone = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'received', v_total,
    'added', cardinality(v_added_ids),
    'changed', (SELECT count(DISTINCT id) FROM unnest(v_changed_ids) AS id WHERE NOT (id = ANY (v_added_ids))),
    'gone', v_gone,
    'issues', v_issues
  );
END;
$$;

DO $$
DECLARE
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.gl_sync_netsuite_accounts(jsonb) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_sync_netsuite_accounts(jsonb) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gl_sync_netsuite_accounts(jsonb) TO service_role;
  END IF;
END $$;

COMMENT ON COLUMN gl_accounts.is_summary IS 'A heading over other accounts (NetSuite "summary" account). Takes no postings.';
COMMENT ON COLUMN gl_accounts.netsuite_type IS 'NetSuite''s own account type (''Bank'', ''AcctRec'', …) as last synced. NULL for an account NetSuite doesn''t have.';
COMMENT ON COLUMN gl_accounts.netsuite_subsidiary_ids IS 'The NetSuite subsidiaries the account is limited to, as last synced. NULL = not known (the list couldn''t be read).';
COMMENT ON COLUMN gl_accounts.sync_issue IS 'Why the last NetSuite sync could not apply everything to this account (a type change after postings, gone from NetSuite). NULL = in step.';
