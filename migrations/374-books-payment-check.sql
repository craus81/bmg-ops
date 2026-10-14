-- Migration 374: FleetSuite's own books, part 8 — customer payments, checked
-- against NetSuite.
--
-- Owner decision 2026-10-14 (thread "Replacing NetSuite with FleetSuite"):
-- customer payments are the next piece, checked against NetSuite first and
-- posted once they match, as invoices were. The payment rule, payment@1
-- (src/lib/books/payment-rule.ts), puts the money in the account the
-- payment was deposited to and credits receivables with its total. The
-- invoices page checks each NetSuite payment against the GL lines NetSuite
-- posted for it (src/lib/books/payment-check.ts).
--
-- This adds one read, gl_payment_month, the payments' counterpart of
-- gl_invoice_month (migrations 364, 367 and 370). No table is added or
-- changed.
--
-- Caller: the service role only, from the super admin page's API.

-- One company's NetSuite customer payments dated in one month, from the
-- ledger mirror's copy (migration 314), each with what it was applied to and
-- the GL lines NetSuite posted for it (migration 361). A payment is a
-- company's when NetSuite posted a GL line of it to that company; one with
-- no GL line in the copy comes back for every company, as an invoice does.
CREATE OR REPLACE FUNCTION public.gl_payment_month(p_company TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH month_payments AS (
    SELECT p.id, p.external_ref, p.doc_number, p.payment_date, p.total, p.voided, p.party_name, p.customer_id
    FROM public.ledger_payments p
    WHERE p.source = 'netsuite'
      AND p.direction = 'in'
      AND p.party_kind = 'customer'
      AND p.deleted_at IS NULL
      AND p.payment_date >= date_trunc('month', p_month)::date
      AND p.payment_date < (date_trunc('month', p_month) + interval '1 month')::date
  ),
  posted AS (
    SELECT m.id, array_agg(DISTINCT c.code ORDER BY c.code) AS companies
    FROM month_payments m
    JOIN public.gl_netsuite_lines l ON l.transaction_id = m.external_ref
    JOIN public.gl_companies c ON c.id = l.company_id
    GROUP BY m.id
  ),
  picked AS (
    SELECT m.*, coalesce(p.companies, ARRAY[]::text[]) AS companies
    FROM month_payments m
    LEFT JOIN posted p ON p.id = m.id
    WHERE p.companies IS NULL OR p_company IS NULL OR p_company = ANY (p.companies)
  )
  SELECT jsonb_build_object(
    'payments', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id,
        'netsuite_id', x.external_ref,
        'number', x.doc_number,
        'date', to_char(x.payment_date, 'YYYY-MM-DD'),
        'total', x.total::text,
        'voided', x.voided,
        'customer', x.party_name,
        'customer_id', x.customer_id,
        'companies', to_jsonb(x.companies),
        'applied', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'kind', a.applied_kind,
            'number', coalesce(i.doc_number, a.applied_external_id),
            'amount', a.amount::text
          ) ORDER BY coalesce(i.doc_number, a.applied_external_id), a.id), '[]'::jsonb)
          FROM public.ledger_payment_applications a
          LEFT JOIN public.ledger_invoices i ON i.id = a.applied_invoice_id
          WHERE a.payment_id = x.id
        ),
        'netsuite', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'line_id', l.line_id,
            'account', l.netsuite_account_id,
            'debit', l.debit::text,
            'credit', l.credit::text
          ) ORDER BY l.line_id::bigint), '[]'::jsonb)
          FROM public.gl_netsuite_lines l
          WHERE l.transaction_id = x.external_ref
        )
      ) ORDER BY x.payment_date, x.doc_number, x.id), '[]'::jsonb)
      FROM picked x
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.gl_payment_month(text, date) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_payment_month(text, date) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gl_payment_month(text, date) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_payment_month(text, date) IS 'Migration 374: one company''s NetSuite customer payments dated in one month (the ledger mirror''s copy, migration 314), each with what it was applied to and the GL lines NetSuite posted for it (migration 361), for the payment rule''s check. Service role only.';
