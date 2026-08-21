import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/parts/transactions?itemId=<NetSuite item internal id>
 *
 * Every customer-side NetSuite transaction a part appears on — invoices,
 * sales orders, estimates — newest first (field ask, 2026-08-21: "parts
 * catalog should give me a link to all transactions that the parts have
 * been involved with"). Feeds the Transactions modal on the parts catalog,
 * which offers the record PDF and a packing list per row.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const itemId = req.nextUrl.searchParams.get('itemId') || '';
  if (!/^\d{1,15}$/.test(itemId)) {
    return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });
  }

  // Quantity is stored negative for sales transactions; flip for display.
  const query = `
    SELECT
      t.id,
      t.tranid,
      t.type,
      t.trandate,
      t.otherrefnum,
      c.companyname AS customer_name,
      SUM(-tl.quantity) AS quantity
    FROM transaction t
    INNER JOIN transactionline tl
      ON tl.transaction = t.id
    LEFT JOIN customer c
      ON c.id = t.entity
    WHERE tl.item = ${itemId}
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND t.type IN ('CustInvc', 'SalesOrd', 'Estimate')
    GROUP BY t.id, t.tranid, t.type, t.trandate, t.otherrefnum, c.companyname
    ORDER BY t.trandate DESC, t.id DESC
    FETCH FIRST 200 ROWS ONLY
  `;

  try {
    const result = await suiteqlQuery(query);
    const transactions = (result?.items || []).map((r: any) => ({
      id: String(r.id),
      tranid: r.tranid || '',
      type: r.type || '',
      date: r.trandate || null,
      poNumber: r.otherrefnum || null,
      customer: r.customer_name || null,
      quantity: parseFloat(r.quantity || '0') || 0,
    }));
    return NextResponse.json({ transactions });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
