import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netsuite/customer-invoices?customerId=123
 * Returns recent invoices for a customer from NetSuite via SuiteQL.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get('customerId');

    if (!customerId) {
      return NextResponse.json({ error: 'customerId required' }, { status: 400 });
    }

    const query = `
      SELECT
        t.id,
        t.tranid,
        t.trandate,
        t.type,
        t.foreigntotal AS total,
        t.status,
        BUILTIN.DF(t.status) AS status_display
      FROM transaction t
      WHERE t.entity = ${customerId}
        AND t.type IN ('CustInvc', 'SalesOrd', 'Estimate')
        AND t.mainline = 'T'
      ORDER BY t.trandate DESC
    `;

    const result = await suiteqlQuery(query, 200);
    const transactions = (result?.items || []).map((t: any) => ({
      id: t.id,
      tranid: t.tranid,
      trandate: t.trandate,
      type: t.type,
      total: t.total ? parseFloat(t.total) : 0,
      status: t.status_display || t.status,
    }));

    return NextResponse.json({ success: true, transactions });
  } catch (e: any) {
    console.error('Customer invoices error:', e);
    return NextResponse.json(
      { error: e.message || 'Failed to fetch invoices' },
      { status: 500 }
    );
  }
}
