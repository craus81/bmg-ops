import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';
import { jobOrderLinesFromRows, stripStatusPrefix, type JobOrderData } from '@/lib/job-order';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/netsuite/job-order/[id]
 *
 * Everything a Job Order (a sales order printed as a pick ticket, no
 * pricing) shows: the SO header and its lines, read live from NetSuite.
 * Never selects rate, amount or total. See src/lib/job-order.ts.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const soId = params.id;
  if (!soId || !/^\d+$/.test(soId)) {
    return NextResponse.json({ error: 'Invalid sales order id' }, { status: 400 });
  }

  try {
    const headerRes = await suiteqlQuery(`
      SELECT
        t.id, t.tranid, t.trandate, t.otherrefnum, t.memo,
        t.custbody_vin_number_ AS vin,
        BUILTIN.DF(t.status) AS status_label,
        c.companyname AS customer_name
      FROM transaction t
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.id = ${soId}
        AND t.type = 'SalesOrd'
    `);
    const h = headerRes?.items?.[0];
    if (!h) {
      return NextResponse.json({ error: 'Sales order not found in NetSuite' }, { status: 404 });
    }

    // Nice-to-have header fields go in their own queries, so a field this
    // account doesn't expose costs that field, not the whole printout.
    const [extraRes, shipToRes, linesRes] = await Promise.all([
      suiteqlQuery(`
        SELECT t.shipdate, BUILTIN.DF(t.shipmethod) AS ship_method, BUILTIN.DF(t.employee) AS sales_rep
        FROM transaction t WHERE t.id = ${soId}
      `).catch(() => null),
      suiteqlQuery(`
        SELECT sa.addrtext
        FROM transaction t
        INNER JOIN transactionshippingaddress sa ON sa.nkey = t.shippingaddress
        WHERE t.id = ${soId}
      `).catch(() => null),
      suiteqlQuery(`
        SELECT
          i.itemid       AS part_number,
          i.displayname  AS display_name,
          i.itemtype     AS item_type,
          tl.memo        AS description,
          tl.quantity    AS quantity
        FROM transactionline tl
        LEFT JOIN item i ON i.id = tl.item
        WHERE tl.transaction = ${soId}
          AND tl.mainline = 'F'
          AND tl.taxline = 'F'
        ORDER BY tl.linesequencenumber
      `),
    ]);
    const extra = extraRes?.items?.[0] || {};
    const shipTo = String(shipToRes?.items?.[0]?.addrtext || '').trim() || null;

    const data: JobOrderData = {
      id: String(h.id),
      soNumber: h.tranid || String(h.id),
      orderDate: h.trandate || null,
      customer: h.customer_name || null,
      poNumber: h.otherrefnum || null,
      vin: h.vin || null,
      memo: h.memo || null,
      status: stripStatusPrefix(h.status_label),
      salesRep: extra.sales_rep || null,
      shipDate: extra.shipdate || null,
      shipMethod: extra.ship_method || null,
      shipTo,
      lines: jobOrderLinesFromRows(linesRes?.items || []),
    };
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
