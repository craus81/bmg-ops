-- Migration 503: FleetSuite's own books, part 77 — each customer's and
-- vendor's balance at the end of a month, for the year-end package.
--
-- The NetSuite Exit Checklist's "Year-end close" (thread "Replacing NetSuite
-- with FleetSuite", owner's go-ahead 2026-10-31): the CPA's year-end package
-- (parts 75 and 76, Books → Year end) lists what each customer owed and each
-- vendor was owed at December 31, FleetSuite's books next to NetSuite's, and
-- how they come to the receivable and payable accounts on its trial balance
-- (src/lib/books/report-workbook.ts, docs/books.md "Year end"). Migration
-- 406's gl_party_balances has each balance as it stands now. This adds:
--   * gl_party_balances_through(company, kind, month), the same balances
--     through the end of a month, counted as Reports counts a month:
--     NetSuite's lines in the month NetSuite posted them to (its accounting
--     period), FleetSuite's by entry date, as the trial balance and the
--     general ledger read them (migrations 361, 396 and 460). A document a
--     later month reverses or changes counts as it stood then. A null month
--     counts every one.
--   * gl_party_balances(company, kind) is now gl_party_balances_through with
--     no month, so both share migration 406's rules; what it returns doesn't
--     change.
--
-- Read-only functions, service role only, no table changes.

-- ── Balances through a month ───────────────────────────────────────────────

-- Every customer's (p_kind 'customer') or vendor's ('vendor') balance in one
-- company's books on the chart's receivable (payable) accounts at the end of
-- p_month's month, both sides, returned as gl_party_balances (migration 406)
-- returns them: accounts, opening and parties, each party's netsuite and
-- fleetsuite what each side moved since the starting entry through that
-- month, its documents and differing those in it, members' amounts likewise.
-- The starting entry is where the accounts stood before 2025, the same
-- whatever the month.
CREATE OR REPLACE FUNCTION public.gl_party_balances_through(p_company TEXT, p_kind TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  -- The last month counted, and the day after it; null with no month.
  span AS (
    SELECT date_trunc('month', p_month)::date AS last_month,
           (date_trunc('month', p_month) + interval '1 month')::date AS after
  ),
  accounts AS (
    SELECT a.id, a.netsuite_account_id, a.number, a.name
    FROM public.gl_accounts a
    WHERE a.account_type = CASE p_kind WHEN 'customer' THEN 'accounts_receivable' WHEN 'vendor' THEN 'accounts_payable' END
      AND (a.company_id IS NULL OR a.company_id = (SELECT id FROM company))
  ),
  ns_accounts AS (
    SELECT netsuite_account_id FROM accounts WHERE netsuite_account_id IS NOT NULL
  ),
  -- NetSuite's customers the ledger mirror matched to a FleetSuite customer by their NetSuite ids.
  matched AS (
    SELECT substr(lc.external_id, 10) AS entity_id, lc.customer_id
    FROM public.ledger_customers lc
    WHERE p_kind = 'customer' AND lc.source = 'netsuite' AND lc.external_id LIKE 'customer/%'
      AND lc.match_status = 'exact' AND lc.customer_id IS NOT NULL
  ),
  ns_lines AS (
    SELECT CASE WHEN p_kind = 'vendor' THEN coalesce(l.entity_id, '') ELSE coalesce(m.customer_id::text, '') END AS party,
           coalesce(l.entity_id, '') AS entity_id,
           l.transaction_id AS doc,
           l.debit - l.credit AS net
    FROM public.gl_netsuite_lines l
    LEFT JOIN matched m ON m.entity_id = l.entity_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.netsuite_account_id IN (SELECT netsuite_account_id FROM ns_accounts)
      AND (p_month IS NULL OR l.posting_month <= (SELECT last_month FROM span))
  ),
  fs_lines AS (
    SELECT CASE WHEN p_kind = 'vendor' THEN coalesce(l.vendor_ref, '') ELSE coalesce(l.customer_id::text, '') END AS party,
           CASE WHEN coalesce(o.source_id, e.source_id) ~ '^[0-9]+$' THEN coalesce(o.source_id, e.source_id)
                ELSE 'entry:' || coalesce(o.id, e.id)::text END AS doc,
           l.debit - l.credit AS net
    FROM public.gl_lines l
    JOIN public.gl_entries e ON e.id = l.entry_id
    LEFT JOIN public.gl_entries o ON o.id = e.reverses_entry_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.account_id IN (SELECT id FROM accounts)
      AND (p_month IS NULL OR l.entry_date < (SELECT after FROM span))
  ),
  docs AS (
    SELECT coalesce(n.party, f.party) AS party,
           coalesce(n.net, 0) AS netsuite,
           coalesce(f.net, 0) AS fleetsuite
    FROM (SELECT party, doc, sum(net) AS net FROM ns_lines GROUP BY party, doc) n
    FULL JOIN (SELECT party, doc, sum(net) AS net FROM fs_lines GROUP BY party, doc) f
      ON f.party = n.party AND f.doc = n.doc
  ),
  moved AS (
    SELECT party,
           sum(netsuite) AS netsuite,
           sum(fleetsuite) AS fleetsuite,
           count(*) FILTER (WHERE netsuite <> 0 OR fleetsuite <> 0) AS documents,
           count(*) FILTER (WHERE netsuite <> fleetsuite) AS differing
    FROM docs
    GROUP BY party
  ),
  opening_lines AS (
    SELECT CASE WHEN p_kind = 'vendor' THEN o.entity_id ELSE coalesce(m.customer_id::text, '') END AS party,
           o.entity_id,
           o.debit - o.credit AS net
    FROM public.gl_netsuite_opening_parties o
    LEFT JOIN matched m ON m.entity_id = o.entity_id
    WHERE o.company_id = (SELECT id FROM company)
      AND o.netsuite_account_id IN (SELECT netsuite_account_id FROM ns_accounts)
  ),
  balances AS (
    SELECT coalesce(m.party, o.party) AS party,
           coalesce(o.net, 0) AS opening,
           coalesce(m.netsuite, 0) AS netsuite,
           coalesce(m.fleetsuite, 0) AS fleetsuite,
           coalesce(m.documents, 0) AS documents,
           coalesce(m.differing, 0) AS differing
    FROM moved m
    FULL JOIN (SELECT party, sum(net) AS net FROM opening_lines GROUP BY party) o ON o.party = m.party
  ),
  shown AS (
    SELECT * FROM balances
    WHERE opening + netsuite <> 0 OR opening + fleetsuite <> 0 OR differing > 0
  ),
  -- NetSuite's names among the customers FleetSuite's books can't name, with what each holds there.
  members AS (
    SELECT x.entity_id, sum(x.opening) AS opening, sum(x.netsuite) AS netsuite
    FROM (
      SELECT entity_id, 0::numeric AS opening, net AS netsuite FROM ns_lines WHERE p_kind = 'customer' AND party = ''
      UNION ALL
      SELECT entity_id, net, 0 FROM opening_lines WHERE p_kind = 'customer' AND party = ''
    ) x
    GROUP BY x.entity_id
    HAVING sum(x.opening) + sum(x.netsuite) <> 0
  ),
  -- The starting entry on each account next to what of it is by name.
  opening_check AS (
    SELECT coalesce(a.debit, 0) = coalesce(b.debit, 0)
             AND coalesce(a.credit, 0) = coalesce(b.credit, 0)
             AND coalesce(a.line_count, 0) = coalesce(b.line_count, 0) AS same
    FROM (
      SELECT netsuite_account_id, debit, credit, line_count
      FROM public.gl_netsuite_opening
      WHERE company_id = (SELECT id FROM company) AND netsuite_account_id IN (SELECT netsuite_account_id FROM ns_accounts)
    ) a
    FULL JOIN (
      SELECT netsuite_account_id, sum(debit) AS debit, sum(credit) AS credit, sum(line_count) AS line_count
      FROM public.gl_netsuite_opening_parties
      WHERE company_id = (SELECT id FROM company) AND netsuite_account_id IN (SELECT netsuite_account_id FROM ns_accounts)
      GROUP BY netsuite_account_id
    ) b ON b.netsuite_account_id = a.netsuite_account_id
  )
  SELECT jsonb_build_object(
    'accounts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_account_id', a.netsuite_account_id, 'number', a.number, 'name', a.name
      ) ORDER BY a.number NULLS LAST, a.name), '[]'::jsonb)
      FROM accounts a
    ),
    'opening', jsonb_build_object(
      'total', (
        SELECT coalesce(sum(o.debit - o.credit), 0)::text
        FROM public.gl_netsuite_opening o
        WHERE o.company_id = (SELECT id FROM company) AND o.netsuite_account_id IN (SELECT netsuite_account_id FROM ns_accounts)
      ),
      'named', (SELECT coalesce(sum(net), 0)::text FROM opening_lines),
      'complete', (SELECT coalesce(bool_and(same), true) FROM opening_check)
    ),
    'parties', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'party', s.party,
        'name', CASE
          WHEN p_kind = 'vendor' THEN (
            SELECT coalesce(v.name, lc.display_name)
            FROM (SELECT s.party AS entity_id) x
            LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = x.entity_id
            LEFT JOIN public.ledger_customers lc ON lc.source = 'netsuite' AND lc.external_id = 'customer/' || x.entity_id
          )
          WHEN s.party ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN coalesce(
            (SELECT nullif(btrim(c.company_name), '') FROM public.customers c WHERE c.id = s.party::uuid),
            (SELECT lc.display_name FROM public.ledger_customers lc
             WHERE lc.source = 'netsuite' AND lc.match_status = 'exact' AND lc.customer_id = s.party::uuid
             ORDER BY lc.external_id LIMIT 1)
          )
        END,
        'netsuite_ids', CASE
          WHEN p_kind = 'vendor' THEN CASE WHEN s.party = '' THEN '[]'::jsonb ELSE jsonb_build_array(s.party) END
          WHEN s.party ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (
            SELECT coalesce(jsonb_agg(m.entity_id ORDER BY m.entity_id::bigint), '[]'::jsonb)
            FROM matched m WHERE m.customer_id = s.party::uuid AND m.entity_id ~ '^[0-9]+$'
          )
          ELSE '[]'::jsonb
        END,
        'opening', s.opening::text,
        'netsuite', s.netsuite::text,
        'fleetsuite', s.fleetsuite::text,
        'documents', s.documents,
        'differing', s.differing,
        'members', CASE WHEN p_kind = 'customer' AND s.party = '' THEN (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'entity_id', t.entity_id,
            'name', (SELECT lc.display_name FROM public.ledger_customers lc
                     WHERE lc.source = 'netsuite' AND lc.external_id = 'customer/' || t.entity_id),
            'opening', t.opening::text,
            'netsuite', t.netsuite::text
          ) ORDER BY abs(t.opening + t.netsuite) DESC, t.entity_id), '[]'::jsonb)
          FROM (SELECT * FROM members ORDER BY abs(opening + netsuite) DESC, entity_id LIMIT 200) t
        ) END,
        'members_count', CASE WHEN p_kind = 'customer' AND s.party = '' THEN (SELECT count(*) FROM members) END
      ) ORDER BY s.party), '[]'::jsonb)
      FROM shown s
    )
  )
$$;

-- ── Balances now ───────────────────────────────────────────────────────────

-- As migration 406 had it: every month counted.
CREATE OR REPLACE FUNCTION public.gl_party_balances(p_company TEXT, p_kind TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT public.gl_party_balances_through(p_company, p_kind, NULL::date)
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.gl_party_balances_through(text, text, date)',
    'public.gl_party_balances(text, text)'
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

COMMENT ON FUNCTION public.gl_party_balances_through(text, text, date) IS 'Migration 503: every customer''s (kind customer) or vendor''s (vendor) balance in one company''s books on the receivable or payable accounts at the end of a month (every month when null), FleetSuite''s journal by entry date next to the copy of NetSuite''s GL by posting month, from the shared starting entry, with how many of their documents differ, for the year-end package. Service role only.';
COMMENT ON FUNCTION public.gl_party_balances(text, text) IS 'Migrations 406 and 503: every customer''s (kind customer) or vendor''s (vendor) balance in one company''s books on the receivable or payable accounts, FleetSuite''s journal next to the copy of NetSuite''s GL from the shared starting entry, with how many of their documents differ, for Customer and vendor balances, the agings and the daily check: gl_party_balances_through with every month. Service role only.';
