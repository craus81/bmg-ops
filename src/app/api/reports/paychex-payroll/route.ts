import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFinancials } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { buildPayrollReport, guessProfile, defaultPayrollRole, type StoredCheck } from '@/lib/paychex-payroll';
import { getShopLaborCostBases } from '@/lib/shop-labor';
import { rolesOf } from '@/lib/ai-agent-access';

export const dynamic = 'force-dynamic';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GetSchema = z.object({ from: dateStr.optional(), to: dateStr.optional() });

/**
 * GET /api/reports/paychex-payroll?from=&to=
 *
 * The Paychex payroll report (migration 340): every rollup for the checks
 * whose pay period ENDS in [from, to] (default: this calendar year), the
 * Paychex employee ↔ FleetSuite person matches with best guesses for the
 * unmatched, each employee's payroll role (migration 341) with a suggestion
 * from their FleetSuite login role when unset, recent uploads, and the shop
 * cost rates the margin report is using. Per-person pay is here and nowhere else — super_admin / executive.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;
  const year = new Date().getFullYear();
  const from = q.data.from || `${year}-01-01`;
  const to = q.data.to || `${year}-12-31`;

  const service = createServiceClient();
  const { data: checks, error } = await fetchAllRows<StoredCheck>((f, t) => service
    .from('payroll_checks')
    .select('id, company_name, employee_name, paychex_employee_id, regular_amount, regular_hours, overtime_amount, overtime_hours, total_earnings, er_benefits, er_taxes, total_labor_cost, period_start, period_end, location, position')
    .gte('period_end', from)
    .lte('period_end', to)
    .order('period_end')
    .order('id')
    .range(f, t));
  if (error) return NextResponse.json({ error: 'Failed to load payroll: ' + error.message }, { status: 500 });

  // Everyone Paychex has ever sent, for matching — not just this range.
  const { data: everyone } = await fetchAllRows<{ paychex_employee_id: string; employee_name: string; period_end: string }>((f, t) => service
    .from('payroll_checks')
    .select('paychex_employee_id, employee_name, period_end')
    .order('period_end', { ascending: false })
    .order('id')
    .range(f, t));
  const latestName = new Map<string, string>();
  for (const r of everyone) if (!latestName.has(r.paychex_employee_id)) latestName.set(r.paychex_employee_id, r.employee_name);

  const [{ data: links }, { data: roleRows }, { data: profiles }, { data: imports }] = await Promise.all([
    service.from('payroll_employee_links').select('paychex_employee_id, profile_id'),
    service.from('payroll_employee_roles').select('paychex_employee_id, role'),
    service.from('profiles').select('id, full_name, role, roles, status').neq('role', 'customer').order('full_name'),
    service.from('payroll_imports')
      .select('id, file_name, uploaded_at, uploaded_by, row_count, period_count, first_period_start, last_period_end, replaced_rows')
      .order('uploaded_at', { ascending: false })
      .limit(10),
  ]);
  const staff = (profiles || []).filter((p: any) => p.status !== 'denied');
  const linkByEmp = new Map((links || []).map(l => [l.paychex_employee_id, l.profile_id]));
  const linkedProfiles = new Set((links || []).map(l => l.profile_id));
  const nameById = new Map(staff.map((p: any) => [p.id, p.full_name]));
  const profileById = new Map(staff.map((p: any) => [p.id, p]));
  const roleByEmp = new Map((roleRows || []).map(r => [r.paychex_employee_id, r.role as string]));

  const employees = [...latestName.entries()]
    .map(([id, name]) => {
      const profileId = linkByEmp.get(id) || null;
      const guess = profileId ? null : guessProfile(name, staff.filter((p: any) => !linkedProfiles.has(p.id)));
      const role = roleByEmp.get(id) || null;
      const forRole = profileId || guess?.id;
      return {
        paychex_employee_id: id,
        employee_name: name,
        profile_id: profileId,
        profile_name: profileId ? nameById.get(profileId) || null : null,
        guess_profile_id: guess?.id || null,
        role,
        suggested_role: role ? null : (forRole ? defaultPayrollRole(rolesOf(profileById.get(forRole))) : null),
      };
    })
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));

  const uploaderIds = [...new Set((imports || []).map(i => i.uploaded_by).filter(Boolean))];
  const uploaderNames = new Map(staff.filter((p: any) => uploaderIds.includes(p.id)).map((p: any) => [p.id, p.full_name]));

  return NextResponse.json({
    range: { from, to },
    report: buildPayrollReport(checks.map(c => ({ ...c, role: roleByEmp.get(c.paychex_employee_id) || null }))),
    employees,
    profiles: staff.map((p: any) => ({ id: p.id, full_name: p.full_name })),
    imports: (imports || []).map(i => ({ ...i, uploaded_by_name: i.uploaded_by ? uploaderNames.get(i.uploaded_by) || null : null })),
    shopCostBases: await getShopLaborCostBases(service),
  });
}
