import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';
import { safeIntId, SqlSafeError } from '@/lib/sql-safe';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(req.url);
    const customerId = safeIntId(searchParams.get('customerId'), 'customerId');
    // status narrows the invoice set (used by the bulk-download UI):
    //   open    -> unpaid invoices (status 'A')
    //   paid    -> paid in full (status 'B')
    //   pastdue -> unpaid AND due date already passed
    //   all     -> every invoice regardless of status
    // Absent -> the legacy mixed document view (invoices + SOs + estimates).
    const statusFilter = searchParams.get('status');
    // Optional trandate range, YYYY-MM-DD (regex-validated — these are
    // interpolated into SuiteQL).
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');
    const dateClause =
      (dateFrom && dateRe.test(dateFrom) ? ` AND t.trandate >= TO_DATE('${dateFrom}', 'YYYY-MM-DD')` : '') +
      (dateTo && dateRe.test(dateTo) ? ` AND t.trandate <= TO_DATE('${dateTo}', 'YYYY-MM-DD')` : '');
    // Pagination — long-history accounts (e.g. Aerodynamics) easily
    // exceed the old hard-coded 200 cap. Clients can keep paging with
    // ?limit & ?offset.
    const rawLimit = parseInt(searchParams.get('limit') || '200', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 1000)) : 200;
    const rawOffset = parseInt(searchParams.get('offset') || '0', 10);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    // In this NetSuite install the invoice status keys are 'A' = Open and
    // 'B' = Paid In Full (see /api/netsuite/invoices STATUS_MAP).
    const statusClause =
      statusFilter === 'open' ? `AND t.type = 'CustInvc' AND t.status = 'A'`
      : statusFilter === 'paid' ? `AND t.type = 'CustInvc' AND t.status = 'B'`
      : statusFilter === 'pastdue' ? `AND t.type = 'CustInvc' AND t.status = 'A' AND t.duedate < TRUNC(SYSDATE)`
      : statusFilter === 'all' ? `AND t.type = 'CustInvc'`
      : `AND t.type IN ('CustInvc', 'SalesOrd', 'Estimate')`;

    const query = `
      SELECT
        t.id,
        t.tranid,
        t.trandate,
        t.duedate,
        t.type,
        t.foreigntotal AS total,
        t.status AS status_key,
        BUILTIN.DF(t.status) AS status_display
      FROM transaction t
      WHERE t.entity = ${customerId}
        ${statusClause}
        ${dateClause}
      ORDER BY t.trandate DESC
    `;

    const result = await suiteqlQuery(query, limit, offset);
    // BUILTIN.DF(t.status) comes back prefixed with the record type
    // ("Invoice : Paid In Full"), which breaks equality checks downstream —
    // map the raw status key for invoices and keep the display value only
    // as a fallback for other transaction types.
    const transactions = (result?.items || []).map((t: any) => ({
      id: t.id,
      tranid: t.tranid,
      trandate: t.trandate,
      duedate: t.duedate || null,
      type: t.type,
      total: t.total ? parseFloat(t.total) : 0,
      status: t.status_key === 'B' ? 'Paid In Full'
        : t.status_key === 'A' ? 'Open'
        : (t.status_display || '').replace(/^[^:]+:\s*/, ''),
    }));

    // hasMore is the standard "exhaustively-paginated-or-not" probe —
    // if we got a full page back, assume there's at least one more.
    const hasMore = transactions.length === limit;
    return NextResponse.json({ success: true, transactions, hasMore, limit, offset });
  } catch (e: any) {
    if (e instanceof SqlSafeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error('Customer documents error:', e);
    return NextResponse.json({ error: e.message || 'Failed to fetch documents' }, { status: 500 });
  }
}
