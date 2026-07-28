import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { safeIntId, SqlSafeError } from '@/lib/sql-safe';
import { fetchOpenArInvoices } from '@/lib/financials-data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netsuite/customer-statement?customerId=<NetSuite internal id>
 *
 * One customer's open invoices with open balances — the data behind the
 * "Print statement" action on the Customer Record page. Same rows and
 * open-balance semantics as the Financials A/R drill-down (partial payments
 * age at what's actually owed), but staff-gated: statements are a sales/AR
 * task, not an executive-only financial view.
 *
 * Response: { success, unpaidColumn, invoices: OpenArInvoice[] }.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const customerId = safeIntId(req.nextUrl.searchParams.get('customerId'), 'customerId');
    const { invoices, unpaidColumn } = await fetchOpenArInvoices(customerId);
    invoices.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.tranid.localeCompare(b.tranid));
    return NextResponse.json({ success: true, unpaidColumn, invoices });
  } catch (e: any) {
    if (e instanceof SqlSafeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
