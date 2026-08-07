import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { fetchAccountGroups } from '@/lib/financials-data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/reports/financials/accounts
 *
 * Per-account GL balances behind the Cash and Credit-card tiles (and the A/P
 * control account), from the financials RESTlet — account name, type, and
 * current balance for every env-configured account id. This is the "which
 * accounts make up that number" drill-down.
 *
 * Response: { success, error?, bank: AccountBalance[], card: AccountBalance[],
 * ap: AccountBalance[], salesTax: AccountBalance[] }. success=false (with the
 * RESTlet's error) when the RESTlet isn't deployed/reachable — the UI shows
 * the hint instead of numbers.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  try {
    const groups = await fetchAccountGroups();
    return NextResponse.json(groups);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
