import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';
import { safeIntId, SqlSafeError } from '@/lib/sql-safe';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(req.url);
    const customerId = safeIntId(searchParams.get('customerId'), 'customerId');
    // status=open narrows to open invoices (used by the bulk-download UI).
    const statusFilter = searchParams.get('status');
    // Pagination — long-history accounts (e.g. Aerodynamics) easily
    // exceed the old hard-coded 200 cap. Clients can keep paging with
    // ?limit & ?offset.
    const rawLimit = parseInt(searchParams.get('limit') || '200', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 1000)) : 200;
    const rawOffset = parseInt(searchParams.get('offset') || '0', 10);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    // In this NetSuite install the open-invoice status key is 'A'
    // (see /api/netsuite/invoices STATUS_MAP).
    const statusClause = statusFilter === 'open'
      ? `AND t.type = 'CustInvc' AND t.status = 'A'`
      : `AND t.type IN ('CustInvc', 'SalesOrd', 'Estimate')`;

    const query = `
      SELECT
        t.id,
        t.tranid,
        t.trandate,
        t.type,
        t.foreigntotal AS total,
        BUILTIN.DF(t.status) AS status_display
      FROM transaction t
      WHERE t.entity = ${customerId}
        ${statusClause}
      ORDER BY t.trandate DESC
    `;

    const result = await suiteqlQuery(query, limit, offset);
    const transactions = (result?.items || []).map((t: any) => ({
      id: t.id,
      tranid: t.tranid,
      trandate: t.trandate,
      type: t.type,
      total: t.total ? parseFloat(t.total) : 0,
      status: t.status_display || '',
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
