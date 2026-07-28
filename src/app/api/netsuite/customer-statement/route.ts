import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { safeIntId, SqlSafeError } from '@/lib/sql-safe';
import { fetchStatementInvoices, type StatementScope } from '@/lib/financials-data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netsuite/customer-statement
 *   ?customerId=<NetSuite internal id>
 *   &scope=open|all           (default open — the classic open-item statement;
 *                              'all' includes paid invoices at $0 balance)
 *   &from=YYYY-MM-DD&to=YYYY-MM-DD   (optional trandate range)
 *
 * One customer's invoices for a statement — the data behind the Statement
 * actions (PDF / print / email) on the Customer Record page. Same open-
 * balance semantics as the Financials A/R drill-down (partial payments age
 * at what's actually owed), but staff-gated: statements are a sales/AR
 * task, not an executive-only financial view.
 *
 * Response: { success, unpaidColumn, scope, from, to, invoices: StatementInvoice[] }.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const params = req.nextUrl.searchParams;
    const customerId = safeIntId(params.get('customerId'), 'customerId');
    const scope: StatementScope = params.get('scope') === 'all' ? 'all' : 'open';
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const from = dateRe.test(params.get('from') || '') ? params.get('from') : null;
    const to = dateRe.test(params.get('to') || '') ? params.get('to') : null;

    const { invoices, unpaidColumn } = await fetchStatementInvoices(customerId, { scope, from, to });
    invoices.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.tranid.localeCompare(b.tranid));
    return NextResponse.json({ success: true, unpaidColumn, scope, from, to, invoices });
  } catch (e: any) {
    if (e instanceof SqlSafeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
