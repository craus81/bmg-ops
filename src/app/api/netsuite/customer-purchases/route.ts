import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';
import { safeIntId, safeIsoDate, SqlSafeError } from '@/lib/sql-safe';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(req.url);
    const customerId = safeIntId(searchParams.get('customerId'), 'customerId');
    const startDateRaw = searchParams.get('startDate');
    const endDateRaw = searchParams.get('endDate');
    const startDate = startDateRaw ? safeIsoDate(startDateRaw, 'startDate') : null;
    const endDate = endDateRaw ? safeIsoDate(endDateRaw, 'endDate') : null;

    let dateFilter = '';
    if (startDate && endDate) {
      dateFilter = `AND t.trandate >= '${startDate}' AND t.trandate <= '${endDate}'`;
    } else if (startDate) {
      dateFilter = `AND t.trandate >= '${startDate}'`;
    } else if (endDate) {
      dateFilter = `AND t.trandate <= '${endDate}'`;
    }

    // Fetch sales order line items for this customer
    const query = `
      SELECT
        t.tranid AS so_number,
        t.trandate AS order_date,
        t.otherrefnum AS po_number,
        tl.item AS item_id,
        BUILTIN.DF(tl.item) AS item_name,
        tl.quantity,
        tl.rate,
        tl.netamount AS line_total,
        tl.memo AS description
      FROM transactionline tl
      INNER JOIN transaction t ON t.id = tl.transaction
      WHERE t.type = 'SalesOrd'
        AND t.entity = ${customerId}
        AND tl.mainline = 'F'
        AND tl.item IS NOT NULL
        ${dateFilter}
      ORDER BY t.trandate DESC, t.tranid, tl.linesequencenumber
      FETCH FIRST 1000 ROWS ONLY
    `;

    const result = await suiteqlQuery(query);
    const lines = (result?.items || []).map((row: any) => ({
      soNumber: row.so_number || '',
      orderDate: row.order_date || '',
      poNumber: row.po_number || '',
      itemName: row.item_name || '',
      quantity: parseFloat(row.quantity) || 0,
      rate: parseFloat(row.rate) || 0,
      lineTotal: parseFloat(row.line_total) || 0,
      description: row.description || '',
    }));

    // Calculate summary
    const totalSpend = lines.reduce((s: number, l: any) => s + l.lineTotal, 0);
    const uniqueOrders = new Set(lines.map((l: any) => l.soNumber)).size;
    const uniqueItems = new Set(lines.map((l: any) => l.itemName)).size;

    return NextResponse.json({
      lines,
      summary: {
        totalSpend,
        totalLines: lines.length,
        uniqueOrders,
        uniqueItems,
        avgOrderValue: uniqueOrders > 0 ? totalSpend / uniqueOrders : 0,
      },
    });
  } catch (err: any) {
    if (err instanceof SqlSafeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('Customer purchases error:', err);
    return NextResponse.json({ error: err.message || 'Failed to fetch purchases' }, { status: 500 });
  }
}
