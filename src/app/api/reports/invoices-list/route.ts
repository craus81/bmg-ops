import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';
import { cached, CACHE_TTL } from '@/lib/cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reports/invoices-list?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Every NetSuite customer invoice in the window — regardless of where it was
 * created — one row per invoice with its net total (line sums excluding tax,
 * the same math as /api/reports/invoiced-summary and the Sales by Customer
 * report, so the Invoicing hub's list always adds up to the dashboard KPI).
 */
const fetchInvoices = cached(
  async (start: string, end: string) => {
    const query = `
      SELECT
        t.id                AS invoice_id,
        t.tranid            AS invoice_number,
        t.trandate          AS trandate,
        t.duedate           AS duedate,
        t.status            AS status,
        t.otherrefnum       AS po_number,
        c.companyname       AS customer,
        SUM(-tl.netamount)  AS net_total
      FROM transaction t
      INNER JOIN transactionline tl ON tl.transaction = t.id
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.type = 'CustInvc'
        AND t.trandate BETWEEN TO_DATE('${start}', 'YYYY-MM-DD') AND TO_DATE('${end}', 'YYYY-MM-DD')
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
      GROUP BY t.id, t.tranid, t.trandate, t.duedate, t.status, t.otherrefnum, c.companyname
      ORDER BY t.trandate DESC, t.tranid DESC
    `;
    const invoices: any[] = [];
    const PAGE = 1000;
    const HARD_CAP = 5000;
    let offset = 0;
    while (offset < HARD_CAP) {
      const result = await suiteqlQuery(query, PAGE, offset);
      const items: any[] = result?.items || [];
      for (const r of items) {
        // NetSuite invoice status: today SuiteQL returns 'A' (Open) /
        // 'B' (Paid In Full); some environments return the text label
        // (and 2026.2 standardizes REST responses to letters) — accept both.
        const raw = String(r.status || '');
        const status: 'open' | 'paid' | null =
          raw === 'B' || /paid/i.test(raw) ? 'paid' :
          raw === 'A' || /open/i.test(raw) ? 'open' : null;
        const iso = (d: any): string | null => {
          if (!d) return null;
          const s = String(d);
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
          const parsed = new Date(s);
          return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
        };
        invoices.push({
          invoiceId: String(r.invoice_id ?? ''),
          invoiceNumber: String(r.invoice_number ?? ''),
          date: iso(r.trandate),
          dueDate: iso(r.duedate),
          status,
          po: r.po_number || null,
          customer: r.customer || 'Unknown',
          total: parseFloat(r.net_total || '0') || 0,
        });
      }
      if (items.length < PAGE) break;
      offset += PAGE;
    }
    return invoices;
  },
  ['reports', 'invoices-list'],
  { revalidate: CACHE_TTL.MEDIUM, tags: ['netsuite:invoices'] },
);

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: 'start and end (YYYY-MM-DD) are required' }, { status: 400 });
  }

  try {
    const invoices = await fetchInvoices(start, end);
    return NextResponse.json({ success: true, invoices });
  } catch (err: any) {
    console.error('invoices-list error:', err);
    return NextResponse.json({ error: err?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
