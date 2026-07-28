import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { fetchOpenVendorBills } from '@/lib/financials-data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/reports/financials/ap-bills
 *
 * Open vendor bills (headers) — the drill-down detail under the A/P tile.
 * The tile itself is the NetSuite A/P account balance from the financials
 * RESTlet; this list is what the integration role can see via SuiteQL. The
 * two can differ legitimately (vendor credits and unapplied payments are
 * invisible to the role), which the UI explains rather than hides.
 *
 * Response: { success, unpaidColumn, bills: OpenVendorBill[] } sorted most
 * overdue first, then by open balance.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  try {
    const { bills, unpaidColumn } = await fetchOpenVendorBills();
    bills.sort((a, b) => b.daysPastDue - a.daysPastDue || b.unpaid - a.unpaid);
    return NextResponse.json({ success: true, unpaidColumn, bills });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
