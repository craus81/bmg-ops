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
        t.id AS id,
        t.tranid AS invoice_number,
        t.trandate AS invoice_date,
        t.foreigntotal AS total,
        t.status AS status,
        BUILTIN.DF(t.status) AS status_display,
        t.duedate AS due_date
      FROM transaction t
      WHERE t.entity = ${customerId}
        AND t.type = 'CustInvc'
        AND t.mainline = 'T'
      ORDER BY t.trandate DESC
    `;

    const result = await suiteqlQuery(query, 100);
    const invoices = result?.items || [];

    return NextResponse.json({ success: true, invoices });
  } catch (e: any) {
    console.error('Customer invoices error:', e);
    return NextResponse.json(
      { error: e.message || 'Failed to fetch invoices' },
      { status: 500 }
    );
  }
}
