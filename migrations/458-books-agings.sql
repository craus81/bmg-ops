-- Migration 458: FleetSuite's own books, part 32 — AR and AP agings.
--
-- Owner decision 2026-10-31 (thread "Replacing NetSuite with FleetSuite",
-- "Build all of this without me", the NetSuite Exit Checklist's "AR and AP
-- agings"): who owes BMG and who BMG owes, by how late (current, 1 to 30
-- days, 31 to 60, 61 to 90, over 90), FleetSuite's books next to NetSuite's
-- (src/lib/books/agings.ts, docs/books.md "AR and AP agings"):
--   * gl_netsuite_open_items, NetSuite's open invoices, credit memos, bills
--     and bill credits, each with what's still open on it and when it's due,
--     read whole every two hours by src/lib/books/netsuite-open-items.ts,
--     which gl_netsuite_store_open_items replaces whole;
--   * gl_party_open_documents(company, kind), each customer's (vendor's)
--     open documents in one company's books, both sides.
--
-- What's open on a document. NetSuite says what's still open on each of its
-- invoices and bills (foreignamountunpaid), as Financials reads it, and
-- that's NetSuite's side. FleetSuite's books don't yet record which payment
-- paid which invoice: until they do, what's been paid on a document is
-- NetSuite's, so FleetSuite's side is NetSuite's open amount plus whatever
-- FleetSuite's books have more on the document than NetSuite's (less, when
-- negative). A document FleetSuite's books don't have isn't open in them,
-- though NetSuite's ledger has it. What a party's documents leave of its
-- balance (a payment not applied to an invoice yet, a journal entry, a
-- difference on a payment) is the page's "not in an open invoice", worked
-- out from the balances of migration 406's gl_party_balances.
--
-- Who a document belongs to is decided as on Customer and vendor balances
-- (migration 406): a customer is the FleetSuite customer the ledger mirror
-- matched NetSuite's customer to (ledger_customers, match_status 'exact'),
-- the party '' the ones it hasn't; a vendor is NetSuite's id for it.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_netsuite_open_items (
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  tran_type TEXT NOT NULL CHECK (tran_type IN ('CustInvc', 'CustCred', 'VendBill', 'VendCred')),
  tranid TEXT,
  trandate DATE NOT NULL,
  due_date DATE,
  -- NetSuite's id for the document's name (its main line's, else its own), '' for none.
  entity_id TEXT NOT NULL CHECK (entity_id = '' OR entity_id ~ '^[0-9]+$'),
  -- The subsidiary of its main line; a company is linked to one (gl_companies.netsuite_subsidiary_id).
  subsidiary_id TEXT CHECK (subsidiary_id ~ '^[0-9]+$'),
  -- What's still open on it, as it sits on the receivable or payable account: debit positive, so an invoice and a
  -- bill credit are positive, a credit memo and a bill negative.
  amount_open NUMERIC(14,2) NOT NULL CHECK (amount_open <> 0),
  CHECK ((tran_type IN ('CustInvc', 'VendCred')) = (amount_open > 0))
);
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_open_items_subsidiary ON gl_netsuite_open_items(subsidiary_id, tran_type);

-- ── The writer ─────────────────────────────────────────────────────────────

-- Replaces the copy with what NetSuite gave now. p:
--   { items: [{ netsuite_id, tran_type, tranid, trandate, due_date, entity_id ('' for none), subsidiary_id,
--               amount_open }] }
-- An empty list empties it. Returns how many rows it holds.
CREATE OR REPLACE FUNCTION public.gl_netsuite_store_open_items(p JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF jsonb_typeof(p->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: items must be a list';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_open_items'));
  -- WHERE true: safeupdate refuses a DELETE without a WHERE clause.
  DELETE FROM public.gl_netsuite_open_items WHERE true;
  INSERT INTO public.gl_netsuite_open_items (netsuite_id, tran_type, tranid, trandate, due_date, entity_id, subsidiary_id, amount_open)
  SELECT x.netsuite_id, x.tran_type, nullif(btrim(x.tranid), ''), x.trandate, x.due_date, coalesce(x.entity_id, ''),
         x.subsidiary_id, x.amount_open
  FROM jsonb_to_recordset(p->'items') AS x(
    netsuite_id TEXT, tran_type TEXT, tranid TEXT, trandate DATE, due_date DATE, entity_id TEXT, subsidiary_id TEXT,
    amount_open NUMERIC
  );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

-- ── Open documents ─────────────────────────────────────────────────────────

-- Each customer's (p_kind 'customer') or vendor's ('vendor') open documents
-- in one company's books, both sides: every invoice and credit memo (bill
-- and bill credit) NetSuite has open in the company's subsidiary, and every
-- one whose lines on the chart's receivable (payable) accounts differ
-- between FleetSuite's journal and the copy of NetSuite's general ledger,
-- for the party, as gl_party_documents (migration 406) has them. Debit
-- positive, decimal strings. Returns
--   linked     whether the company is linked to a NetSuite subsidiary, which
--              NetSuite's open documents are read from;
--   documents  how many open documents NetSuite has in it, of the kind;
--   parties    each party with a document here: party, name, netsuite_ids;
--   rows       each document open on either side, for a party: party, doc
--              (NetSuite's id), type (NetSuite's), number, date, the due
--              date each side (netsuite_due, and fleetsuite_due: FleetSuite's
--              own copy of an invoice's, else NetSuite's), what's open on it
--              each side (netsuite, fleetsuite), and whether each side's
--              ledger has lines of it since 2025 (netsuite_lines,
--              fleetsuite_lines).
CREATE OR REPLACE FUNCTION public.gl_party_open_documents(p_company TEXT, p_kind TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id, netsuite_subsidiary_id FROM public.gl_companies WHERE code = p_company
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
  -- The documents that age: what's owed on an invoice (bill), and what a credit memo (bill credit) has left to apply.
  aged AS (
    SELECT unnest(CASE p_kind WHEN 'customer' THEN ARRAY['CustInvc', 'CustCred'] WHEN 'vendor' THEN ARRAY['VendBill', 'VendCred'] END) AS tran_type
  ),
  -- NetSuite's customers the ledger mirror matched to a FleetSuite customer by their NetSuite ids.
  matched AS (
    SELECT substr(lc.external_id, 10) AS entity_id, lc.customer_id
    FROM public.ledger_customers lc
    WHERE p_kind = 'customer' AND lc.source = 'netsuite' AND lc.external_id LIKE 'customer/%'
      AND lc.match_status = 'exact' AND lc.customer_id IS NOT NULL
  ),
  open_items AS (
    SELECT CASE WHEN p_kind = 'vendor' THEN o.entity_id ELSE coalesce(m.customer_id::text, '') END AS party,
           o.netsuite_id AS doc, o.tran_type, o.tranid, o.trandate, o.due_date, o.amount_open
    FROM public.gl_netsuite_open_items o
    LEFT JOIN matched m ON m.entity_id = o.entity_id
    WHERE o.subsidiary_id = (SELECT netsuite_subsidiary_id FROM company)
      AND o.tran_type IN (SELECT tran_type FROM aged)
  ),
  ns_docs AS (
    SELECT CASE WHEN p_kind = 'vendor' THEN coalesce(l.entity_id, '') ELSE coalesce(m.customer_id::text, '') END AS party,
           l.transaction_id AS doc,
           sum(l.debit - l.credit) AS net
    FROM public.gl_netsuite_lines l
    LEFT JOIN matched m ON m.entity_id = l.entity_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.netsuite_account_id IN (SELECT netsuite_account_id FROM ns_accounts)
    GROUP BY 1, 2
  ),
  fs_lines AS (
    SELECT CASE WHEN p_kind = 'vendor' THEN coalesce(l.vendor_ref, '') ELSE coalesce(l.customer_id::text, '') END AS party,
           CASE WHEN coalesce(o.source_id, e.source_id) ~ '^[0-9]+$' THEN coalesce(o.source_id, e.source_id)
                ELSE 'entry:' || coalesce(o.id, e.id)::text END AS doc,
           coalesce(o.source_type, e.source_type) AS kind,
           e.reverses_entry_id IS NOT NULL AS reversal,
           e.entry_no,
           e.entry_date,
           l.debit - l.credit AS net
    FROM public.gl_lines l
    JOIN public.gl_entries e ON e.id = l.entry_id
    LEFT JOIN public.gl_entries o ON o.id = e.reverses_entry_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.account_id IN (SELECT id FROM accounts)
  ),
  fs_docs AS (
    SELECT party, doc,
           min(kind) AS kind,
           sum(net) AS net,
           -- The date of its latest entry that isn't a reversal.
           (array_agg(entry_date ORDER BY entry_no DESC) FILTER (WHERE NOT reversal))[1] AS entry_date
    FROM fs_lines
    GROUP BY party, doc
  ),
  -- Every document open on NetSuite's side, or whose two sides differ for the party.
  keyed AS (
    SELECT party, doc FROM open_items
    UNION
    SELECT coalesce(n.party, f.party), coalesce(n.doc, f.doc)
    FROM ns_docs n
    FULL JOIN fs_docs f ON f.party = n.party AND f.doc = n.doc
    WHERE coalesce(n.net, 0) <> coalesce(f.net, 0)
  ),
  docs AS (
    SELECT k.party, k.doc,
           coalesce(oi.tran_type, t.tran_type, CASE f.kind
             WHEN 'invoice' THEN 'CustInvc' WHEN 'credit_memo' THEN 'CustCred'
             WHEN 'vendor_bill' THEN 'VendBill' WHEN 'vendor_credit' THEN 'VendCred' END) AS tran_type,
           coalesce(oi.tranid, t.tranid) AS tranid,
           coalesce(oi.trandate, t.trandate, f.entry_date) AS doc_date,
           oi.due_date AS open_due,
           coalesce(oi.amount_open, 0) AS ns_open,
           coalesce(n.net, 0) AS ns_net,
           n.doc IS NOT NULL AS ns_has,
           coalesce(f.net, 0) AS fs_net,
           f.doc IS NOT NULL AS fs_has
    FROM keyed k
    LEFT JOIN open_items oi ON oi.party = k.party AND oi.doc = k.doc
    LEFT JOIN ns_docs n ON n.party = k.party AND n.doc = k.doc
    LEFT JOIN fs_docs f ON f.party = k.party AND f.doc = k.doc
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = k.doc
  ),
  aged_docs AS (
    SELECT d.*,
           -- NetSuite's open amount plus what FleetSuite's books have more on it; nothing on one they don't have.
           CASE WHEN NOT d.fs_has AND d.ns_has THEN 0 ELSE d.ns_open + d.fs_net - d.ns_net END AS fs_open,
           -- An invoice NetSuite no longer has open still has the due date the ledger mirror copied.
           coalesce(d.open_due, CASE WHEN d.tran_type = 'CustInvc' THEN (
             SELECT li.due_date FROM public.ledger_invoices li
             WHERE li.source = 'netsuite' AND li.external_id = 'CustInvc/' || d.doc
           ) END) AS ns_due
    FROM docs d
    WHERE d.tran_type IN (SELECT tran_type FROM aged)
  ),
  shown AS (
    SELECT a.*,
           coalesce(CASE WHEN a.tran_type = 'CustInvc' THEN (
             SELECT oi.due_date FROM public.gl_own_invoices oi
             WHERE oi.netsuite_id = a.doc AND oi.company_id = (SELECT id FROM company)
           ) END, a.ns_due) AS fs_due
    FROM aged_docs a
    WHERE a.ns_open <> 0 OR a.fs_open <> 0
  )
  SELECT jsonb_build_object(
    'linked', (SELECT netsuite_subsidiary_id IS NOT NULL FROM company),
    'documents', (SELECT count(*) FROM open_items),
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
        END
      ) ORDER BY s.party), '[]'::jsonb)
      FROM (SELECT DISTINCT party FROM shown) s
    ),
    'rows', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'party', s.party,
        'doc', s.doc,
        'type', s.tran_type,
        'number', s.tranid,
        'date', to_char(s.doc_date, 'YYYY-MM-DD'),
        'netsuite_due', to_char(s.ns_due, 'YYYY-MM-DD'),
        'fleetsuite_due', to_char(s.fs_due, 'YYYY-MM-DD'),
        'netsuite', s.ns_open::text,
        'fleetsuite', s.fs_open::text,
        'netsuite_lines', s.ns_has,
        'fleetsuite_lines', s.fs_has
      ) ORDER BY s.party, s.doc_date NULLS LAST, s.tranid NULLS LAST, s.doc), '[]'::jsonb)
      FROM shown s
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE gl_netsuite_open_items ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_netsuite_open_items FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_store_open_items(jsonb)',
    'public.gl_party_open_documents(text, text)'
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

COMMENT ON TABLE gl_netsuite_open_items IS 'Migration 458: NetSuite''s open invoices, credit memos, bills and bill credits, each with what''s still open on it (debit positive, as on the receivable or payable account) and its due date, read whole every two hours by src/lib/books/netsuite-open-items.ts for AR and AP agings. Service-role write and read.';
COMMENT ON FUNCTION public.gl_netsuite_store_open_items(jsonb) IS 'Migration 458: replaces the copy of NetSuite''s open documents (gl_netsuite_open_items) with what NetSuite gave now. Service role only.';
COMMENT ON FUNCTION public.gl_party_open_documents(text, text) IS 'Migration 458: each customer''s (kind customer) or vendor''s (vendor) open documents in one company''s books, what''s open on each FleetSuite''s side and NetSuite''s, with their due dates, for AR and AP agings (src/lib/books/agings.ts). Service role only.';
