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
        AND t.type IN ('CustInvc', 'SalesOrd', 'Estimate')
      ORDER BY t.trandate DESC
    `;

    const result = await suiteqlQuery(query, 200);
    const transactions = (result?.items || []).map((t: any) => ({
      id: t.id,
      tranid: t.tranid,
      trandate: t.trandate,
      type: t.type,
      total: t.total ? parseFloat(t.total) : 0,
      status: t.status_display || '',
    }));

    return NextResponse.json({ success: true, transactions });
  } catch (e: any) {
    if (e instanceof SqlSafeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error('Customer documents error:', e);
    return NextResponse.json({ error: e.message || 'Failed to fetch documents' }, { status: 500 });
  }
}
