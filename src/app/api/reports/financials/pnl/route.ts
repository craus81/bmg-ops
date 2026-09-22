import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { loadPnlPeriod, isPnlPeriodKey, DEFAULT_PNL_PERIOD } from '@/lib/pnl';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reports/financials/pnl?period=<key> (R5-5): GM%, NP%, payroll,
 * labor % and collections for ONE period — from the financials RESTlet's
 * incomeStatement + collections modes. `period` is one of the keys in
 * PNL_PERIOD_KEYS; anything else falls back to the default rather than
 * erroring, so a stale bookmark still renders. The answer carries the full
 * option list so the band's period picker is server-defined.
 *
 * RESTlet unavailability (URL unset, stale deployment, permission gap) is
 * success:false-shaped data at HTTP 200 so the dashboard shows the
 * redeploy/grant hint instead of a hard failure (docs/pnl-restlet-deploy.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const requested = req.nextUrl.searchParams.get('period');
  const key = isPnlPeriodKey(requested) ? requested : DEFAULT_PNL_PERIOD;

  try {
    const { period, options, payrollConfigured } = await loadPnlPeriod(key);
    return NextResponse.json({ period, options, payrollConfigured });
  } catch (e: any) {
    console.error('pnl report failed:', e);
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
