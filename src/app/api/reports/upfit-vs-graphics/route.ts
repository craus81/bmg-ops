import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFinancials } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { buildPayrollReport, type StoredCheck } from '@/lib/paychex-payroll';
import { buildDivisionReport, buildRevenueByItemQuery, type RevenueItemRow } from '@/lib/division-revenue';

export const dynamic = 'force-dynamic';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GetSchema = z.object({ from: dateStr.optional(), to: dateStr.optional() });

/**
 * GET /api/reports/upfit-vs-graphics?from=&to=
 *
 * Upfit vs Graphics by month (owner ask 2026-10-06): NetSuite revenue split
 * by item (src/lib/division-revenue.ts) next to Paychex labor cost split by
 * payroll role. Default range: this calendar year to today. Payroll rolls
 * up per division, so this is financials-only like the payroll report.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;
  const today = new Date().toISOString().slice(0, 10);
  const from = q.data.from || `${today.slice(0, 4)}-01-01`;
  const to = q.data.to || today;
  if (from > to) return NextResponse.json({ error: 'The start date is after the end date.' }, { status: 400 });

  const service = createServiceClient();
  const [revenue, payroll, roles] = await Promise.all([
    suiteqlQueryAll(buildRevenueByItemQuery(from, to)).then(rows => ({ rows: rows as RevenueItemRow[], error: null as string | null }))
      .catch((e: unknown) => ({ rows: [] as RevenueItemRow[], error: e instanceof Error ? e.message : String(e) })),
    fetchAllRows<StoredCheck>((f, t) => service
      .from('payroll_checks')
      .select('id, company_name, employee_name, paychex_employee_id, regular_amount, regular_hours, overtime_amount, overtime_hours, total_earnings, er_benefits, er_taxes, total_labor_cost, period_start, period_end, location, position')
      .gte('period_end', from)
      .lte('period_end', to)
      .order('period_end')
      .order('id')
      .range(f, t)),
    service.from('payroll_employee_roles').select('paychex_employee_id, role'),
  ]);
  if (revenue.error) return NextResponse.json({ error: 'Could not read NetSuite revenue: ' + revenue.error }, { status: 502 });
  if (payroll.error) return NextResponse.json({ error: 'Could not read payroll: ' + payroll.error.message }, { status: 500 });
  if (roles.error) return NextResponse.json({ error: 'Could not read payroll roles: ' + roles.error.message }, { status: 500 });

  const roleByEmp = new Map((roles.data || []).map(r => [r.paychex_employee_id, r.role as string]));
  const labor = buildPayrollReport(payroll.data.map(c => ({ ...c, role: roleByEmp.get(c.paychex_employee_id) || null }))).byMonthDivision;

  return NextResponse.json({
    range: { from, to },
    report: buildDivisionReport(revenue.rows, labor),
    peopleWithoutRole: new Set(payroll.data.filter(c => !roleByEmp.has(c.paychex_employee_id)).map(c => c.paychex_employee_id)).size,
  });
}
