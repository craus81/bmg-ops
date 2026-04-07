import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get('customerId');
    const search = searchParams.get('q')?.trim() || '';

    if (!customerId) {
      return NextResponse.json({ error: 'customerId required' }, { status: 400 });
    }

    let searchFilter = '';
    if (search) {
      const term = search.replace(/'/g, "''");
      searchFilter = `AND (
        UPPER(t.tranid) LIKE UPPER('%${term}%')
        OR UPPER(t.memo) LIKE UPPER('%${term}%')
      )`;
    }

    // Query invoices — same pattern as working getOpenSalesOrdersByCustomer
    const query = `
      SELECT
        t.id,
        t.tranid AS invoice_number,
        t.trandate AS invoice_date,
        t.status,
        t.memo
      FROM transaction t
      WHERE t.type = 'CustInvc'
        AND t.entity = ${customerId}
        ${searchFilter}
      ORDER BY t.trandate DESC
      FETCH FIRST 50 ROWS ONLY
    `;

    const statusMap: Record<string, string> = {
      'A': 'Open',
      'B': 'Paid In Full',
    };

    const result = await suiteqlQuery(query);
    const invoices = (result?.items || []).map((row: any) => ({
      id: row.id,
      invoiceNumber: row.invoice_number || '',
      date: row.invoice_date || '',
      status: statusMap[row.status] || row.status || '',
      memo: row.memo || '',
    }));

    return NextResponse.json({ invoices, count: invoices.length });
  } catch (err: any) {
    console.error('Invoice search error:', err);
    return NextResponse.json({ error: err.message || 'Failed to fetch invoices' }, { status: 500 });
  }
}
