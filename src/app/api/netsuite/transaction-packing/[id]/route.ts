import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/netsuite/transaction-packing/[id]
 *
 * Header + line items for one customer-side transaction (invoice, sales
 * order, or estimate) — exactly what a packing list needs: customer, PO
 * (otherrefnum), transaction number, and qty + part number + description
 * per line. Feeds "print a packing list for any order" from the parts
 * catalog's Transactions modal.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const txId = params.id;
  if (!txId || !/^\d+$/.test(txId)) {
    return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
  }

  try {
    const headerRes = await suiteqlQuery(`
      SELECT t.id, t.tranid, t.type, t.trandate, t.otherrefnum, c.companyname AS customer_name
      FROM transaction t
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.id = ${txId}
        AND t.type IN ('CustInvc', 'SalesOrd', 'Estimate')
    `);
    const header = headerRes?.items?.[0];
    if (!header) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    // Quantity is stored negative for sales transactions; flip for display.
    const linesRes = await suiteqlQuery(`
      SELECT
        i.itemid    AS part_number,
        tl.memo     AS description,
        -tl.quantity AS quantity
      FROM transactionline tl
      LEFT JOIN item i ON i.id = tl.item
      WHERE tl.transaction = ${txId}
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
      ORDER BY tl.linesequencenumber
    `);

    return NextResponse.json({
      header: {
        id: String(header.id),
        tranid: header.tranid || '',
        type: header.type || '',
        date: header.trandate || null,
        poNumber: header.otherrefnum || null,
        customer: header.customer_name || null,
      },
      lines: (linesRes?.items || []).map((r: any) => ({
        partNumber: r.part_number || '',
        description: r.description || '',
        quantity: parseFloat(r.quantity || '0') || 0,
      })).filter((l: { quantity: number }) => l.quantity > 0),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
