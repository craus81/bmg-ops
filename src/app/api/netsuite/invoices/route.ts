import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get('customerId');
    const search = searchParams.get('q')?.trim() || '';

    if (!customerId) {
      return NextResponse.json({ error: 'customerId required' }, { status: 400 });
    }

    // Build optional search filter on invoice number, memo, or PO number
    let searchFilter = '';
    if (search) {
      const term = search.replace(/'/g, "''");
      searchFilter = `AND (
        UPPER(t.tranid) LIKE UPPER('%${term}%')
        OR UPPER(t.memo) LIKE UPPER('%${term}%')
        OR UPPER(t.otherrefnum) LIKE UPPER('%${term}%')
      )`;
    }

    const query = `
      SELECT
        t.id,
        t.tranid AS invoice_number,
        t.trandate AS invoice_date,
        t.status,
        t.statusref AS status_ref,
        BUILTIN.DF(t.status) AS status_display,
        t.total,
        t.foreigntotal,
        t.memo,
        t.otherrefnum AS po_number,
        t.duedate
      FROM transaction t
      WHERE t.type = 'CustInvc'
        AND t.entity = ${customerId}
        ${searchFilter}
      ORDER BY t.trandate DESC
      FETCH FIRST 50 ROWS ONLY
    `;

    const result = await suiteqlQuery(query);
    const invoices = (result?.items || []).map((row: any) => ({
      id: row.id,
      invoiceNumber: row.invoice_number || '',
      date: row.invoice_date || '',
      status: row.status_display || row.status || '',
      total: parseFloat(row.foreigntotal || row.total || '0'),
      memo: row.memo || '',
      poNumber: row.po_number || '',
      dueDate: row.duedate || '',
    }));

    return NextResponse.json({ invoices, count: invoices.length });
  } catch (err: any) {
    console.error('Invoice search error:', err);
    return NextResponse.json({ error: err.message || 'Failed to fetch invoices' }, { status: 500 });
  }
}
