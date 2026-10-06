-- Migration 340: Paychex Flex payroll import (owner ask 2026-10-06).
--
-- Paychex Flex's scheduled "Payroll Labor Cost" custom report is downloaded
-- each payroll and uploaded at Reports → Paychex Payroll. One row per
-- employee per check: regular/overtime pay and hours, gross, employer
-- benefits and taxes, total labor cost, pay period, location, position.
-- It feeds the payroll report, the shop labor cost rate, and the AI agent
-- (super_admin / executive only — the financials tier).
--
-- Re-uploading a pay period REPLACES that period's rows (replace_payroll_periods
-- below runs the delete + insert in one transaction), so loading the
-- year-to-date history and then each new payroll never double counts.
--
-- No RLS policies: only the service role (the API routes and the AI agent's
-- exec_readonly_sql) reads these, behind requireFinancials / canSeeFinancials.

CREATE TABLE IF NOT EXISTS payroll_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT,
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count INTEGER NOT NULL DEFAULT 0,
  period_count INTEGER NOT NULL DEFAULT 0,
  first_period_start DATE,
  last_period_end DATE,
  replaced_rows INTEGER NOT NULL DEFAULT 0   -- earlier rows this upload replaced
);

CREATE TABLE IF NOT EXISTS payroll_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID REFERENCES payroll_imports(id) ON DELETE SET NULL,
  paychex_employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,               -- as Paychex prints it: "Last, First M"
  company_name TEXT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  location TEXT,                             -- Paychex "Business location"
  position TEXT,
  regular_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  regular_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  overtime_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_earnings NUMERIC(12,2) NOT NULL DEFAULT 0,   -- "Total earnings & reimbursements"
  er_benefits NUMERIC(12,2) NOT NULL DEFAULT 0,
  er_taxes NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_labor_cost NUMERIC(12,2) NOT NULL DEFAULT 0, -- earnings + ER benefits + ER taxes
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS payroll_checks_period_idx ON payroll_checks (period_end, period_start);
CREATE INDEX IF NOT EXISTS payroll_checks_employee_idx ON payroll_checks (paychex_employee_id, period_end);

-- Paychex employee → FleetSuite person, set once on the import page.
CREATE TABLE IF NOT EXISTS payroll_employee_links (
  paychex_employee_id TEXT PRIMARY KEY,
  profile_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  linked_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payroll_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_employee_links ENABLE ROW LEVEL SECURITY;

-- One upload, atomically: record the import, drop every existing row for the
-- pay periods (start + end) the file carries, insert the file's rows.
CREATE OR REPLACE FUNCTION public.replace_payroll_periods(p_import JSONB, p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_import_id UUID;
  v_replaced INTEGER;
  v_inserted INTEGER;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'No payroll rows to import';
  END IF;

  INSERT INTO payroll_imports (file_name, uploaded_by, row_count, period_count, first_period_start, last_period_end)
  VALUES (
    p_import->>'file_name',
    NULLIF(p_import->>'uploaded_by', '')::uuid,
    jsonb_array_length(p_rows),
    (SELECT COUNT(DISTINCT (r->>'period_start', r->>'period_end')) FROM jsonb_array_elements(p_rows) r),
    (SELECT MIN((r->>'period_start')::date) FROM jsonb_array_elements(p_rows) r),
    (SELECT MAX((r->>'period_end')::date) FROM jsonb_array_elements(p_rows) r)
  )
  RETURNING id INTO v_import_id;

  DELETE FROM payroll_checks c
  USING (
    SELECT DISTINCT (r->>'period_start')::date AS ps, (r->>'period_end')::date AS pe
    FROM jsonb_array_elements(p_rows) r
  ) p
  WHERE c.period_start = p.ps AND c.period_end = p.pe;
  GET DIAGNOSTICS v_replaced = ROW_COUNT;

  INSERT INTO payroll_checks (
    import_id, paychex_employee_id, employee_name, company_name, period_start, period_end,
    location, position, regular_amount, regular_hours, overtime_amount, overtime_hours,
    total_earnings, er_benefits, er_taxes, total_labor_cost
  )
  SELECT
    v_import_id, r->>'paychex_employee_id', r->>'employee_name', r->>'company_name',
    (r->>'period_start')::date, (r->>'period_end')::date,
    NULLIF(r->>'location', ''), NULLIF(r->>'position', ''),
    COALESCE((r->>'regular_amount')::numeric, 0), COALESCE((r->>'regular_hours')::numeric, 0),
    COALESCE((r->>'overtime_amount')::numeric, 0), COALESCE((r->>'overtime_hours')::numeric, 0),
    COALESCE((r->>'total_earnings')::numeric, 0), COALESCE((r->>'er_benefits')::numeric, 0),
    COALESCE((r->>'er_taxes')::numeric, 0), COALESCE((r->>'total_labor_cost')::numeric, 0)
  FROM jsonb_array_elements(p_rows) r;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE payroll_imports SET replaced_rows = v_replaced WHERE id = v_import_id;

  RETURN jsonb_build_object('import_id', v_import_id, 'inserted', v_inserted, 'replaced', v_replaced);
END;
$$;

REVOKE ALL ON FUNCTION public.replace_payroll_periods(JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_payroll_periods(JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.replace_payroll_periods(JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_payroll_periods(JSONB, JSONB) TO service_role;
