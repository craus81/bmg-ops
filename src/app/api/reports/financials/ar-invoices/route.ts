import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { fetchOpenArInvoices } from '@/lib/financials-data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/reports/financials/ar-invoices
 *
 * Every open customer invoice behind the A/R tile — the drill-down list for
 * verifying the aging, chasing past dues, and printing statements. Same
 * SuiteQL rows the tile aggregates (src/lib/financials-data.ts), so the sum
 * of `unpaid` here reconciles with the tile exactly.
 *
 * Response: { success, unpaidColumn, invoices: OpenArInvoice[] } sorted most
 * overdue first, then by open balance. `unpaidColumn` is false when NetSuite
 * rejected foreignamountunpaid and amounts fell back to invoice totals.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  try {
    const { invoices, unpaidColumn } = await fetchOpenArInvoices();
    invoices.sort((a, b) => b.daysPastDue - a.daysPastDue || b.unpaid - a.unpaid);
    return NextResponse.json({ success: true, unpaidColumn, invoices });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
