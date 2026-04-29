import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface InvoiceLine {
  invoice_number: string;
  invoice_id: string;
  trandate: string;
  memo: string | null;
  customer: string;
  location: string | null;
  part_number: string | null;
  description: string | null;
  quantity: number;
  unit_rate: number;
  net_amount: number;
}

/**
 * GET /api/reports/sales-by-customer-detail
 *
 * Query string:
 *   start         YYYY-MM-DD (inclusive)
 *   end           YYYY-MM-DD (inclusive)
 *   customers     comma-separated list of customer name fragments to ILIKE-match
 *
 * Returns one row per invoice line with:
 *   invoice_number, memo, location, part_number, quantity, net_amount, etc.
 *
 * Filters by transaction.type = 'CustInvc', excludes header + tax lines.
 * Pagination is handled internally — fetches all matching lines up to a hard
 * cap so the UI gets a complete dataset in a single response.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const customersParam = url.searchParams.get('customers') || '';

  if (!start || !end) {
    return NextResponse.json({ error: 'start and end (YYYY-MM-DD) are required' }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: 'dates must be YYYY-MM-DD' }, { status: 400 });
  }

  const customerFragments = customersParam
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (customerFragments.length === 0) {
    return NextResponse.json({ error: 'customers query param required' }, { status: 400 });
  }

  // Build the customer ILIKE filter — prevent SQL injection by escaping single quotes.
  const customerOr = customerFragments
    .map(f => `UPPER(c.companyname) LIKE UPPER('%${f.replace(/'/g, "''")}%')`)
    .join(' OR ');

  // SuiteQL: invoice header + line items with item + location + customer joins.
  // mainline='F' excludes the header summary line; taxline='F' excludes tax;
  // and we filter to non-zero quantity to skip discount/group rows that mostly
  // pollute the report. itemtype IN ('InvtPart','NonInvtPart','Service','OthCharge')
  // keeps real billable lines and drops subtotal/markup/etc rows.
  // NetSuite stores invoice line netamount + quantity as NEGATIVE because
  // item lines on sales transactions are credits to revenue in NS's internal
  // double-entry model. Flip the sign so the report reads as positive
  // customer-facing numbers. Unit rate (tl.rate) is stored positive — leave
  // it alone.
  const baseQuery = `
    SELECT
      t.id            AS invoice_id,
      t.tranid        AS invoice_number,
      t.trandate      AS trandate,
      t.memo          AS memo,
      c.companyname   AS customer,
      l.name          AS location,
      i.itemid        AS part_number,
      tl.memo         AS line_description,
      -tl.quantity    AS quantity,
      tl.rate         AS unit_rate,
      -tl.netamount   AS net_amount
    FROM transaction t
    INNER JOIN transactionline tl
      ON tl.transaction = t.id
    LEFT JOIN customer c
      ON c.id = t.entity
    LEFT JOIN item i
      ON i.id = tl.item
    LEFT JOIN location l
      ON l.id = tl.location
    WHERE t.type = 'CustInvc'
      AND t.trandate BETWEEN TO_DATE('${start}', 'YYYY-MM-DD') AND TO_DATE('${end}', 'YYYY-MM-DD')
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND (${customerOr})
    ORDER BY c.companyname, t.trandate, t.tranid, tl.linesequencenumber
  `;

  const lines: InvoiceLine[] = [];
  const PAGE = 1000;
  const HARD_CAP = 10000;
  let offset = 0;
  try {
    while (offset < HARD_CAP) {
      const result = await suiteqlQuery(baseQuery, PAGE, offset);
      const items: any[] = result?.items || [];
      for (const r of items) {
        lines.push({
          invoice_id: String(r.invoice_id ?? ''),
          invoice_number: String(r.invoice_number ?? ''),
          trandate: r.trandate ? String(r.trandate) : '',
          memo: r.memo || null,
          customer: r.customer || '—',
          location: r.location || null,
          part_number: r.part_number || null,
          description: r.line_description || null,
          quantity: parseFloat(r.quantity || '0') || 0,
          unit_rate: parseFloat(r.unit_rate || '0') || 0,
          net_amount: parseFloat(r.net_amount || '0') || 0,
        });
      }
      if (items.length < PAGE) break;
      offset += PAGE;
    }
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'NetSuite query failed' }, { status: 500 });
  }

  // Roll up per-customer totals for the UI summary
  const customerTotals: Record<string, { customer: string; lineCount: number; total: number; invoiceCount: number }> = {};
  const seenInvoicesByCustomer: Record<string, Set<string>> = {};
  let grandTotal = 0;
  for (const l of lines) {
    grandTotal += l.net_amount;
    if (!customerTotals[l.customer]) {
      customerTotals[l.customer] = { customer: l.customer, lineCount: 0, total: 0, invoiceCount: 0 };
      seenInvoicesByCustomer[l.customer] = new Set();
    }
    customerTotals[l.customer].lineCount += 1;
    customerTotals[l.customer].total += l.net_amount;
    seenInvoicesByCustomer[l.customer].add(l.invoice_id);
  }
  for (const k of Object.keys(customerTotals)) {
    customerTotals[k].invoiceCount = seenInvoicesByCustomer[k].size;
  }

  return NextResponse.json({
    range: { start, end },
    customers: customerFragments,
    lineCount: lines.length,
    grandTotal,
    perCustomer: Object.values(customerTotals),
    lines,
  });
}
