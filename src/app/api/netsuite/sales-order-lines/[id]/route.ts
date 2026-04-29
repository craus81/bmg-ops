import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/netsuite/sales-order-lines/[id]
 *
 * Pulls the line items for a single NetSuite sales order via SuiteQL.
 * Used by the install completion modal to render parts as sub-checkboxes
 * under the "Upfit parts installed per spec" task.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const soId = params.id;
  if (!soId || !/^\d+$/.test(soId)) {
    return NextResponse.json({ error: 'Invalid sales order id' }, { status: 400 });
  }

  // Sales orders use 'SalesOrd' as the transaction type. mainline='F' +
  // taxline='F' filters to billable item lines. Quantity is stored
  // negative for sales transactions; flip it to display as positive.
  const query = `
    SELECT
      tl.linesequencenumber AS line_number,
      i.itemid              AS part_number,
      tl.memo               AS description,
      -tl.quantity          AS quantity,
      tl.rate               AS unit_rate
    FROM transaction t
    INNER JOIN transactionline tl
      ON tl.transaction = t.id
    LEFT JOIN item i
      ON i.id = tl.item
    WHERE t.id = ${soId}
      AND t.type = 'SalesOrd'
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
    ORDER BY tl.linesequencenumber
  `;

  try {
    const result = await suiteqlQuery(query);
    const items = (result?.items || []).map((r: any) => ({
      lineNumber: parseInt(r.line_number || '0', 10),
      partNumber: r.part_number || '',
      description: r.description || '',
      quantity: parseFloat(r.quantity || '0') || 0,
      unitRate: parseFloat(r.unit_rate || '0') || 0,
    }));
    return NextResponse.json({ lines: items });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
