-- Migration 406: FleetSuite's own books, part 22 — each customer's and
-- vendor's balance, next to NetSuite's.
--
-- Owner decision 2026-10-19 (thread "Replacing NetSuite with FleetSuite",
-- "Balance checks"): what each customer owes and each vendor is owed in
-- FleetSuite's books is put next to NetSuite's and checked every morning,
-- so drift shows up by name (src/lib/books/party-balances.ts, docs/books.md
-- "Customer and vendor balances"):
--   * gl_netsuite_opening_parties, by name, what NetSuite's receivable and
--     payable accounts held before 2025: the part of the starting entry
--     (gl_netsuite_opening, migration 361) each customer and vendor holds,
--     read with NetSuite's totals by src/lib/books/netsuite-gl.ts, which
--     gl_netsuite_store_opening_parties replaces whole;
--   * gl_party_balances(company, kind), every customer's or vendor's
--     balance on the chart's receivable or payable accounts, FleetSuite's
--     journal next to the copy of NetSuite's general ledger, both from that
--     starting entry;
--   * gl_party_documents(company, kind, party, differs, limit), the
--     documents behind one of them, both sides.
--
-- Who a line belongs to. A customer is the FleetSuite customer the line
-- names: on FleetSuite's side the journal line's customer_id, on NetSuite's
-- the FleetSuite customer the ledger mirror matched the line's name to by
-- its NetSuite id (ledger_customers, match_status 'exact'), the match
-- journal entries, deposits and bank documents post with (migrations 383,
-- 393, 394). Lines that name no customer, or one the mirror hasn't matched
-- to a FleetSuite customer, belong together to the party '', since
-- FleetSuite's books can't tell them apart; its members are NetSuite's
-- names among them. A vendor is NetSuite's id for the line's name, the
-- journal's vendor_ref, and '' is the lines that name nobody.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_netsuite_opening_parties (
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_account_id TEXT NOT NULL CHECK (netsuite_account_id ~ '^[0-9]+$'),
  -- NetSuite's id for the lines' name, '' for lines that name nobody.
  entity_id TEXT NOT NULL CHECK (entity_id = '' OR entity_id ~ '^[0-9]+$'),
  debit NUMERIC(18,2) NOT NULL,
  credit NUMERIC(18,2) NOT NULL,
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  PRIMARY KEY (company_id, netsuite_account_id, entity_id)
);

-- ── The writer ─────────────────────────────────────────────────────────────

-- Replaces the starting entry by name with what NetSuite gave now. p:
--   { parties: [{ company: 'BMG', netsuite_account_id, entity_id ('' for
--                 none), debit, credit, line_count }] }
-- An empty list empties it: NetSuite has nothing before 2025 on those
-- accounts. Returns how many rows it holds.
CREATE OR REPLACE FUNCTION public.gl_netsuite_store_opening_parties(p JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF jsonb_typeof(p->'parties') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: parties must be a list';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'parties') AS x(company TEXT)
    LEFT JOIN public.gl_companies c ON c.code = x.company WHERE c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'gl: the starting entry by name names a company that doesn''t exist';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_opening_parties'));
  -- WHERE true: safeupdate refuses a DELETE without a WHERE clause.
  DELETE FROM public.gl_netsuite_opening_parties WHERE true;
  INSERT INTO public.gl_netsuite_opening_parties (company_id, netsuite_account_id, entity_id, debit, credit, line_count)
  SELECT c.id, x.netsuite_account_id, coalesce(x.entity_id, ''), x.debit, x.credit, x.line_count
  FROM jsonb_to_recordset(p->'parties') AS x(
    company TEXT, netsuite_account_id TEXT, entity_id TEXT, debit NUMERIC, credit NUMERIC, line_count INTEGER
  )
  JOIN public.gl_companies c ON c.code = x.company;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

-- ── Balances ───────────────────────────────────────────────────────────────

-- Every customer's (p_kind 'customer') or vendor's ('vendor') balance in one
-- company's books on the chart's receivable (payable) accounts, both sides,
-- as Reports count a balance: from the starting entry, which both sides
-- share, then FleetSuite's journal on one side and the copy of NetSuite's
-- general ledger on the other. A document is the same on both sides when
-- FleetSuite's source_id is NetSuite's internal id, a reversal with the
-- document it reverses, as gl_books_account_documents (migration 400) has
-- them. Debit positive, decimal strings. Returns
--   accounts  the accounts counted: netsuite_account_id, number, name;
--   opening   the starting entry on them: total, what of it the starting
--             entry by name holds (named), and complete, when that is
--             every line of it on every account;
--   parties   each party with a balance on either side or a document whose
--             two sides differ: party, name, netsuite_ids (NetSuite's ids
--             for it), opening, netsuite and fleetsuite (what each side
--             moved since), documents (that moved it either side) and
--             differing (whose two sides differ); the customer party '' has
--             members too, NetSuite's names among it with what each holds
--             there (at most 200, the largest first), and members_count.
CREATE OR REPLACE FUNCTION public.gl_party_balances(p_company TEXT, p_kind TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
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

-- ── One party's documents ──────────────────────────────────────────────────

-- The documents behind one party's balance in one company's books, both
-- sides, party and documents as gl_party_balances has them (p_party is a
-- FleetSuite customer's id, a vendor's NetSuite id, or '' for the lines
-- that name neither). A document whose lines for the party come to nothing
-- on both sides is left out. With p_differs, only the documents whose two
-- sides differ. Returns the party's name and NetSuite ids, its opening,
-- how many documents there are and how many differ, what each side's come
-- to (debit positive), and at most p_limit of them (1 to 2000), those that
-- differ first, then the newest first, each as gl_books_account_documents
-- (migration 400) gives a document: doc, netsuite, fleetsuite, kind, type,
-- number, month, date, name, memo, entry_no and entries.
CREATE OR REPLACE FUNCTION public.gl_party_documents(
  p_company TEXT, p_kind TEXT, p_party TEXT, p_differs BOOLEAN, p_limit INTEGER
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  accounts AS (
    SELECT a.id, a.netsuite_account_id
    FROM public.gl_accounts a
    WHERE a.account_type = CASE p_kind WHEN 'customer' THEN 'accounts_receivable' WHEN 'vendor' THEN 'accounts_payable' END
      AND (a.company_id IS NULL OR a.company_id = (SELECT id FROM company))
  ),
  ns_accounts AS (
    SELECT netsuite_account_id FROM accounts WHERE netsuite_account_id IS NOT NULL
  ),
  matched AS (
    SELECT substr(lc.external_id, 10) AS entity_id, lc.customer_id
    FROM public.ledger_customers lc
    WHERE p_kind = 'customer' AND lc.source = 'netsuite' AND lc.external_id LIKE 'customer/%'
      AND lc.match_status = 'exact' AND lc.customer_id IS NOT NULL
  ),
  ns_lines AS (
    SELECT l.transaction_id AS doc, l.line_id, l.entity_id, l.memo, l.debit, l.credit
    FROM public.gl_netsuite_lines l
    LEFT JOIN matched m ON m.entity_id = l.entity_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.netsuite_account_id IN (SELECT netsuite_account_id FROM ns_accounts)
      AND CASE WHEN p_kind = 'vendor' THEN coalesce(l.entity_id, '') ELSE coalesce(m.customer_id::text, '') END = p_party
  ),
  ns AS (
    SELECT doc,
           sum(debit) - sum(credit) AS net,
           (array_agg(entity_id ORDER BY line_id::bigint) FILTER (WHERE entity_id IS NOT NULL))[1] AS entity_id,
           (array_agg(btrim(memo) ORDER BY line_id::bigint) FILTER (WHERE btrim(memo) <> ''))[1] AS memo
    FROM ns_lines
    GROUP BY doc
  ),
  fs_lines AS (
    SELECT CASE WHEN coalesce(o.source_id, e.source_id) ~ '^[0-9]+$' THEN coalesce(o.source_id, e.source_id)
                ELSE 'entry:' || coalesce(o.id, e.id)::text END AS doc,
           coalesce(o.source_type, e.source_type) AS kind,
           e.id AS entry_id,
           e.entry_no,
           e.entry_date,
           coalesce(nullif(btrim(l.memo), ''), nullif(btrim(coalesce(o.memo, e.memo)), '')) AS memo,
           l.line_no,
           l.debit,
           l.credit
    FROM public.gl_lines l
    JOIN public.gl_entries e ON e.id = l.entry_id
    LEFT JOIN public.gl_entries o ON o.id = e.reverses_entry_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.account_id IN (SELECT id FROM accounts)
      AND CASE WHEN p_kind = 'vendor' THEN coalesce(l.vendor_ref, '') ELSE coalesce(l.customer_id::text, '') END = p_party
  ),
  fs AS (
    SELECT doc,
           min(kind) AS kind,
           sum(debit) - sum(credit) AS net,
           count(DISTINCT entry_id) AS entries,
           max(entry_no) AS entry_no,
           (array_agg(entry_date ORDER BY entry_no DESC))[1] AS entry_date,
           (array_agg(memo ORDER BY entry_no, line_no) FILTER (WHERE memo IS NOT NULL))[1] AS memo
    FROM fs_lines
    GROUP BY doc
  ),
  moving AS (
    SELECT coalesce(n.doc, f.doc) AS doc,
           coalesce(n.net, 0) AS netsuite,
           coalesce(f.net, 0) AS fleetsuite,
           f.kind,
           f.entries,
           f.entry_no,
           n.entity_id,
           coalesce(n.memo, f.memo) AS memo,
           t.tran_type,
           t.tranid,
           t.posting_month,
           coalesce(t.trandate, f.entry_date) AS doc_date
    FROM ns n
    FULL JOIN fs f ON f.doc = n.doc
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = coalesce(n.doc, f.doc)
    WHERE coalesce(n.net, 0) <> 0 OR coalesce(f.net, 0) <> 0
  ),
  picked AS (
    SELECT *
    FROM moving
    WHERE NOT coalesce(p_differs, false) OR fleetsuite <> netsuite
    ORDER BY (fleetsuite <> netsuite) DESC, doc_date DESC NULLS LAST, tranid DESC NULLS LAST, doc DESC
    LIMIT greatest(1, least(coalesce(p_limit, 1000), 2000))
  ),
  opening_lines AS (
    SELECT o.debit - o.credit AS net
    FROM public.gl_netsuite_opening_parties o
    LEFT JOIN matched m ON m.entity_id = o.entity_id
    WHERE o.company_id = (SELECT id FROM company)
      AND o.netsuite_account_id IN (SELECT netsuite_account_id FROM ns_accounts)
      AND CASE WHEN p_kind = 'vendor' THEN o.entity_id ELSE coalesce(m.customer_id::text, '') END = p_party
  )
  SELECT jsonb_build_object(
    'party', p_party,
    'name', CASE
      WHEN p_kind = 'vendor' THEN (
        SELECT coalesce(v.name, lc.display_name)
        FROM (SELECT p_party AS entity_id) x
        LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = x.entity_id
        LEFT JOIN public.ledger_customers lc ON lc.source = 'netsuite' AND lc.external_id = 'customer/' || x.entity_id
      )
      WHEN p_party ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN coalesce(
        (SELECT nullif(btrim(c.company_name), '') FROM public.customers c WHERE c.id = p_party::uuid),
        (SELECT lc.display_name FROM public.ledger_customers lc
         WHERE lc.source = 'netsuite' AND lc.match_status = 'exact' AND lc.customer_id = p_party::uuid
         ORDER BY lc.external_id LIMIT 1)
      )
    END,
    'netsuite_ids', CASE
      WHEN p_kind = 'vendor' THEN CASE WHEN p_party = '' THEN '[]'::jsonb ELSE jsonb_build_array(p_party) END
      WHEN p_party ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (
        SELECT coalesce(jsonb_agg(m.entity_id ORDER BY m.entity_id::bigint), '[]'::jsonb)
        FROM matched m WHERE m.customer_id = p_party::uuid AND m.entity_id ~ '^[0-9]+$'
      )
      ELSE '[]'::jsonb
    END,
    'opening', (SELECT coalesce(sum(net), 0)::text FROM opening_lines),
    'documents', (SELECT count(*) FROM moving),
    'differing', (SELECT count(*) FROM moving WHERE fleetsuite <> netsuite),
    'netsuite', (SELECT coalesce(sum(netsuite), 0)::text FROM moving),
    'fleetsuite', (SELECT coalesce(sum(fleetsuite), 0)::text FROM moving),
    'rows', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'doc', p.doc,
        'netsuite', p.netsuite::text,
        'fleetsuite', p.fleetsuite::text,
        'kind', p.kind,
        'type', p.tran_type,
        'number', p.tranid,
        'month', to_char(p.posting_month, 'YYYY-MM-DD'),
        'date', to_char(p.doc_date, 'YYYY-MM-DD'),
        'name', (
          -- The party's own line's name, else the document's first, as gl_books_account_documents names them.
          SELECT coalesce(v.name, lc.display_name)
          FROM (
            SELECT coalesce(p.entity_id, (
              SELECT l.entity_id FROM public.gl_netsuite_lines l
              WHERE l.transaction_id = p.doc AND l.company_id = (SELECT id FROM company) AND l.entity_id IS NOT NULL
              ORDER BY l.line_id::bigint
              LIMIT 1
            )) AS entity_id
          ) x
          LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = x.entity_id
          LEFT JOIN public.ledger_customers lc ON lc.source = 'netsuite' AND lc.external_id = 'customer/' || x.entity_id
        ),
        'memo', p.memo,
        'entry_no', p.entry_no,
        'entries', coalesce(p.entries, 0)
      ) ORDER BY (p.fleetsuite <> p.netsuite) DESC, p.doc_date DESC NULLS LAST, p.tranid DESC NULLS LAST, p.doc DESC), '[]'::jsonb)
      FROM picked p
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE gl_netsuite_opening_parties ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_netsuite_opening_parties FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_store_opening_parties(jsonb)',
    'public.gl_party_balances(text, text)',
    'public.gl_party_documents(text, text, text, boolean, integer)'
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

COMMENT ON TABLE gl_netsuite_opening_parties IS 'Migration 406: by name, what NetSuite''s receivable and payable accounts held before 2025, the part of the starting entry (gl_netsuite_opening) each customer and vendor holds, read with NetSuite''s totals by src/lib/books/netsuite-gl.ts. entity_id is NetSuite''s id for the lines'' name, '''' for none. Service-role write and read.';
COMMENT ON FUNCTION public.gl_netsuite_store_opening_parties(jsonb) IS 'Migration 406: replaces the starting entry by name (gl_netsuite_opening_parties) with what NetSuite gave now. Service role only.';
COMMENT ON FUNCTION public.gl_party_balances(text, text) IS 'Migration 406: every customer''s (kind customer) or vendor''s (vendor) balance in one company''s books on the receivable or payable accounts, FleetSuite''s journal next to the copy of NetSuite''s GL from the shared starting entry, with how many of their documents differ, for Customer and vendor balances and the daily check. Service role only.';
COMMENT ON FUNCTION public.gl_party_documents(text, text, text, boolean, integer) IS 'Migration 406: the documents behind one customer''s or vendor''s balance in one company''s books, both sides, those that differ first. Service role only.';
