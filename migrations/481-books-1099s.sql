-- Migration 481: FleetSuite's own books, part 50 — the 1099 dry run: what
-- each vendor was paid in a year for its 1099, worked out from FleetSuite's
-- copy of NetSuite.
--
-- The NetSuite Exit Checklist (thread "Replacing NetSuite with FleetSuite",
-- 2026-10-31; built without asking under the owner's go of 02:05Z): in
-- January 2027, 2026's totals per payee are worked out from NetSuite's copy
-- and checked against NetSuite's 1099s, before FleetSuite makes 1099s of
-- its own later in 2027. NetSuite counts what a vendor marked to get a 1099
-- was paid by check or bill payment on the accounts it gives a 1099-MISC
-- category, each category a box of the form. The vendors copy (migration
-- 363) now keeps whether a vendor gets a 1099 and its legal name
-- (details.is_1099, 'T' or 'F', and details.legal_name,
-- src/lib/books/netsuite-lists.ts), and this keeps which accounts count:
--
--   gl_netsuite_1099_accounts: each NetSuite account with a 1099-MISC
--     category, by the category's name, read with the chart of accounts
--     every two hours (src/lib/books/netsuite-accounts.ts) and applied by
--     gl_netsuite_1099_accounts_apply. It follows NetSuite and is never
--     written back.
--
-- gl_1099_year reads one company's year for the rule in
-- src/lib/books/1099s.ts, which spreads each bill payment over the accounts
-- of the bills it paid. Nothing is sent or filed.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

CREATE TABLE IF NOT EXISTS gl_netsuite_1099_accounts (
  netsuite_account_id TEXT PRIMARY KEY CHECK (netsuite_account_id ~ '^[0-9]+$'),
  category TEXT NOT NULL CHECK (btrim(category) <> ''),
  category_id TEXT CHECK (category_id ~ '^[0-9]+$'),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Applies NetSuite's whole list of accounts with a 1099-MISC category. p:
--   { accounts: [{ netsuite_account_id, category, category_id? }] }
-- A new one is added, one whose category changed is updated, and one no
-- longer listed is taken off, unless the list looks cut short (none, or
-- under half of the accounts here): then nothing is taken off and it says
-- so. The whole list applies or none of it does. Returns
-- { received, added, changed, removed, here, cut_short }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_1099_accounts_apply(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_bad TEXT;
  v_listed INTEGER;
  v_here INTEGER;
  v_added INTEGER;
  v_changed INTEGER;
  v_removed INTEGER := 0;
  v_cut_short BOOLEAN := false;
BEGIN
  IF jsonb_typeof(p->'accounts') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: accounts must be a list';
  END IF;
  -- One writer at a time: the cron and "Sync now" can land together.
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_1099_accounts'));

  SELECT coalesce(x.v->>'netsuite_account_id', '(none)') INTO v_bad
  FROM jsonb_array_elements(p->'accounts') AS x(v)
  WHERE coalesce(x.v->>'netsuite_account_id', '') !~ '^[0-9]+$'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite account id "%" isn''t a number', v_bad;
  END IF;
  SELECT x.v->>'netsuite_account_id' INTO v_bad
  FROM jsonb_array_elements(p->'accounts') AS x(v)
  GROUP BY x.v->>'netsuite_account_id'
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite account % is in the list twice', v_bad;
  END IF;
  SELECT x.v->>'netsuite_account_id' INTO v_bad
  FROM jsonb_array_elements(p->'accounts') AS x(v)
  WHERE btrim(coalesce(x.v->>'category', '')) = ''
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite account % has no 1099 category', v_bad;
  END IF;

  v_listed := jsonb_array_length(p->'accounts');
  SELECT count(*) INTO v_here FROM public.gl_netsuite_1099_accounts;

  WITH incoming AS (
    SELECT x.v->>'netsuite_account_id' AS netsuite_account_id,
           btrim(x.v->>'category') AS category,
           nullif(x.v->>'category_id', '') AS category_id
    FROM jsonb_array_elements(p->'accounts') AS x(v)
  ), written AS (
    INSERT INTO public.gl_netsuite_1099_accounts AS a (netsuite_account_id, category, category_id)
    SELECT i.netsuite_account_id, i.category, i.category_id FROM incoming i
    ON CONFLICT (netsuite_account_id) DO UPDATE SET
      category = EXCLUDED.category,
      category_id = EXCLUDED.category_id,
      changed_at = now()
    WHERE (a.category, a.category_id) IS DISTINCT FROM (EXCLUDED.category, EXCLUDED.category_id)
    RETURNING (xmax = 0) AS added
  )
  SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added)
  INTO v_added, v_changed
  FROM written;

  IF v_here > 0 AND (v_listed = 0 OR v_listed * 2 < v_here) THEN
    v_cut_short := true;
  ELSE
    DELETE FROM public.gl_netsuite_1099_accounts a
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p->'accounts') AS x(v)
      WHERE x.v->>'netsuite_account_id' = a.netsuite_account_id
    );
    GET DIAGNOSTICS v_removed = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'received', v_listed, 'added', v_added, 'changed', v_changed, 'removed', v_removed,
    'here', v_here, 'cut_short', v_cut_short
  );
END;
$$;

-- One company's year for its 1099s, by the date each payment was made:
--   payments:   the checks and bill payments dated in the year to vendors
--               NetSuite marks to get a 1099, and to anyone else when the
--               check, or a bill a bill payment paid, has a line on an
--               account that counts toward a 1099; and the card charges and
--               refunds of vendors marked to get one. Voided ones, ones of
--               no money, and ones gone from NetSuite are left out. Each
--               comes with its GL lines in the copy of NetSuite's ledger
--               (migration 361), and a bill payment with what it paid
--               (migration 389), each document with its own GL lines
--               (null when the copy of the ledger doesn't have it: dated
--               before 2025, say). A payment is the company's when NetSuite
--               posted a GL line of it to that company; one with no GL line
--               in the copy comes back for every company.
--   payees:     the vendors copy's row (migration 363) for each payee that
--               is a vendor
--   accounts:   the chart (migration 360), each account's type and number
--   categories: which accounts count toward a 1099, by the category's name
--   flags_copied: whether the vendors copy has any vendor's 1099 flag yet
--   not_copied: checks and bill payments the copy of the ledger has dated
--               in the year for the company that the copies of the
--               payments don't (yet)
CREATE OR REPLACE FUNCTION public.gl_1099_year(p_company TEXT, p_year INTEGER)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH bounds AS (
    SELECT make_date(p_year, 1, 1) AS y_from, make_date(p_year + 1, 1, 1) AS y_to
  ),
  marked AS (
    SELECT v.netsuite_id FROM public.gl_netsuite_lists v
    WHERE v.kind = 'vendor' AND v.details->>'is_1099' = 'T'
  ),
  docs AS (
    SELECT b.netsuite_id, b.tran_type, b.tranid, b.trandate, b.vendor_netsuite_id AS payee,
           b.vendor_name AS payee_name, b.total, b.links
    FROM public.gl_netsuite_bill_payments b
    CROSS JOIN bounds m
    WHERE b.gone_at IS NULL AND NOT b.voided AND b.total > 0
      AND b.trandate >= m.y_from AND b.trandate < m.y_to
    UNION ALL
    SELECT s.netsuite_id, s.tran_type, s.tranid, s.trandate, s.payee_netsuite_id, s.payee_name, s.total, NULL::jsonb
    FROM public.gl_netsuite_spending s
    CROSS JOIN bounds m
    WHERE s.gone_at IS NULL AND NOT s.voided AND s.total > 0
      AND s.trandate >= m.y_from AND s.trandate < m.y_to
  ),
  mine AS (
    SELECT d.* FROM docs d
    WHERE NOT EXISTS (SELECT 1 FROM public.gl_netsuite_lines l WHERE l.transaction_id = d.netsuite_id)
       OR EXISTS (
         SELECT 1 FROM public.gl_netsuite_lines l
         JOIN public.gl_companies c ON c.id = l.company_id
         WHERE l.transaction_id = d.netsuite_id AND c.code = p_company
       )
  ),
  wanted AS (
    SELECT m.* FROM mine m
    WHERE EXISTS (SELECT 1 FROM marked k WHERE k.netsuite_id = m.payee)
       OR (m.tran_type = 'Check' AND EXISTS (
            SELECT 1 FROM public.gl_netsuite_lines l
            JOIN public.gl_netsuite_1099_accounts a ON a.netsuite_account_id = l.netsuite_account_id
            WHERE l.transaction_id = m.netsuite_id
          ))
       OR (m.tran_type = 'VendPymt' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(coalesce(m.links, '[]'::jsonb)) AS k(v)
            JOIN public.gl_netsuite_lines l ON l.transaction_id = k.v->>'netsuite_id'
            JOIN public.gl_netsuite_1099_accounts a ON a.netsuite_account_id = l.netsuite_account_id
          ))
  )
  SELECT jsonb_build_object(
    'payments', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', w.netsuite_id,
        'type', w.tran_type,
        'number', w.tranid,
        'date', to_char(w.trandate, 'YYYY-MM-DD'),
        'payee', w.payee,
        'payee_name', w.payee_name,
        'total', w.total::text,
        'lines', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'account', l.netsuite_account_id, 'debit', l.debit::text, 'credit', l.credit::text
          ) ORDER BY l.line_id::bigint), '[]'::jsonb)
          FROM public.gl_netsuite_lines l
          WHERE l.transaction_id = w.netsuite_id
        ),
        'links', CASE WHEN w.links IS NULL THEN NULL ELSE (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'netsuite_id', k.v->>'netsuite_id',
            'type', coalesce(t.tran_type, k.v->>'type'),
            'number', coalesce(k.v->>'number', t.tranid),
            'amount', k.v->>'amount',
            'lines', CASE WHEN t.netsuite_id IS NULL THEN NULL ELSE (
              SELECT coalesce(jsonb_agg(jsonb_build_object(
                'account', l.netsuite_account_id, 'debit', l.debit::text, 'credit', l.credit::text
              ) ORDER BY l.line_id::bigint), '[]'::jsonb)
              FROM public.gl_netsuite_lines l
              WHERE l.transaction_id = t.netsuite_id
            ) END
          ) ORDER BY k.n), '[]'::jsonb)
          FROM jsonb_array_elements(w.links) WITH ORDINALITY AS k(v, n)
          LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = k.v->>'netsuite_id'
        ) END
      ) ORDER BY w.trandate, w.tranid, w.netsuite_id::bigint), '[]'::jsonb)
      FROM wanted w
    ),
    'payees', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', v.netsuite_id,
        'name', v.name,
        'entity_id', v.details->>'entity_id',
        'legal_name', v.details->>'legal_name',
        'is_1099', v.details->>'is_1099'
      ) ORDER BY v.netsuite_id::bigint), '[]'::jsonb)
      FROM public.gl_netsuite_lists v
      WHERE v.kind = 'vendor'
        AND v.netsuite_id IN (SELECT w.payee FROM wanted w WHERE w.payee IS NOT NULL)
    ),
    'accounts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', a.netsuite_account_id, 'number', a.number, 'name', a.name, 'type', a.account_type
      ) ORDER BY a.netsuite_account_id::bigint), '[]'::jsonb)
      FROM public.gl_accounts a
      WHERE a.netsuite_account_id IS NOT NULL
    ),
    'categories', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('netsuite_id', a.netsuite_account_id, 'category', a.category)
                                ORDER BY a.netsuite_account_id::bigint), '[]'::jsonb)
      FROM public.gl_netsuite_1099_accounts a
    ),
    'flags_copied', EXISTS (SELECT 1 FROM public.gl_netsuite_lists v WHERE v.kind = 'vendor' AND v.details ? 'is_1099'),
    'not_copied', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', t.netsuite_id, 'type', t.tran_type, 'number', t.tranid, 'date', to_char(t.trandate, 'YYYY-MM-DD')
      ) ORDER BY t.trandate, t.netsuite_id::bigint), '[]'::jsonb)
      FROM public.gl_netsuite_transactions t
      CROSS JOIN bounds m
      WHERE t.tran_type IN ('Check', 'VendPymt')
        AND t.trandate >= m.y_from AND t.trandate < m.y_to
        AND EXISTS (
          SELECT 1 FROM public.gl_netsuite_lines l JOIN public.gl_companies c ON c.id = l.company_id
          WHERE l.transaction_id = t.netsuite_id AND c.code = p_company
        )
        AND NOT EXISTS (SELECT 1 FROM public.gl_netsuite_bill_payments b WHERE b.netsuite_id = t.netsuite_id AND b.gone_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.gl_netsuite_spending s WHERE s.netsuite_id = t.netsuite_id AND s.gone_at IS NULL)
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE gl_netsuite_1099_accounts ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_netsuite_1099_accounts FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_1099_accounts_apply(jsonb)',
    'public.gl_1099_year(text, integer)'
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

COMMENT ON TABLE gl_netsuite_1099_accounts IS 'Migration 481: the NetSuite accounts that count toward a 1099, each with its 1099-MISC category, read with the chart of accounts every two hours by src/lib/books/netsuite-accounts.ts for the 1099s page. Follows NetSuite until the changeover. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_1099_accounts.category IS 'The account''s 1099-MISC category as NetSuite names it (Nonemployee Compensation, Rents, ...): the box of the form what''s paid on the account goes in.';
COMMENT ON COLUMN gl_netsuite_1099_accounts.category_id IS 'NetSuite''s internal id for the category, when it gave one.';
COMMENT ON FUNCTION public.gl_netsuite_1099_accounts_apply(jsonb) IS 'Migration 481: applies NetSuite''s whole list of accounts with a 1099-MISC category, taking off those no longer listed unless the list looks cut short. Service role only.';
COMMENT ON FUNCTION public.gl_1099_year(text, integer) IS 'Migration 481: one company''s year for its 1099s: the checks, bill payments and card charges to vendors marked to get a 1099 or on accounts that count toward one, with their GL lines and what each bill payment paid, the payees, the chart, the accounts that count, and the payments the copies don''t have yet. Read only. Service role only.';
