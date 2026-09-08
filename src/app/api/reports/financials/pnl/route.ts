import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { loadPnlPeriods } from '@/lib/pnl';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reports/financials/pnl (R5-5): GM%, NP%, payroll, labor % and
 * collections for month-to-date (directional), last full month (closed),
 * and year-to-date — from the financials RESTlet's incomeStatement +
 * collections modes. Each period fails independently; RESTlet
 * unavailability (URL unset, stale deployment, permission gap) is
 * success:false-shaped data at HTTP 200 so the dashboard shows the
 * redeploy/grant hint instead of a hard failure (docs/pnl-restlet-deploy.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  try {
    const { periods, payrollConfigured } = await loadPnlPeriods();
    return NextResponse.json({ periods, payrollConfigured });
  } catch (e: any) {
    console.error('pnl report failed:', e);
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
