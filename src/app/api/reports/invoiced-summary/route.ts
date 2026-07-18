import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';
import { cached, CACHE_TTL } from '@/lib/cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * GET /api/reports/invoiced-summary
 *
 * All-customer invoiced totals for the dashboard's "Invoiced this month" KPI,
 * straight from NetSuite. Uses the same line filters as the Sales by Customer
 * report (type CustInvc, mainline='F', taxline='F', sign-flipped netamount)
 * so the KPI and the report always agree.
 *
 * Returns: {
 *   thisMonth:        { total, invoices },   // 1st of month → today
 *   lastMonthToDate:  { total },             // same day-window last month (fair % compare)
 *   lastMonthFull:    { total },
 * }
 */
const fetchInvoicedSummary = cached(
  async (monthStart: string, lastMonthStart: string, lastMonthSameDay: string, lastMonthEnd: string) => {
    const query = `
      SELECT
        SUM(CASE WHEN t.trandate >= TO_DATE('${monthStart}', 'YYYY-MM-DD') THEN -tl.netamount ELSE 0 END) AS this_month,
        COUNT(DISTINCT CASE WHEN t.trandate >= TO_DATE('${monthStart}', 'YYYY-MM-DD') THEN t.id END) AS this_month_invoices,
        SUM(CASE WHEN t.trandate BETWEEN TO_DATE('${lastMonthStart}', 'YYYY-MM-DD') AND TO_DATE('${lastMonthSameDay}', 'YYYY-MM-DD') THEN -tl.netamount ELSE 0 END) AS last_month_to_date,
        SUM(CASE WHEN t.trandate BETWEEN TO_DATE('${lastMonthStart}', 'YYYY-MM-DD') AND TO_DATE('${lastMonthEnd}', 'YYYY-MM-DD') THEN -tl.netamount ELSE 0 END) AS last_month_full
      FROM transaction t
      INNER JOIN transactionline tl ON tl.transaction = t.id
      WHERE t.type = 'CustInvc'
        AND t.trandate >= TO_DATE('${lastMonthStart}', 'YYYY-MM-DD')
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
    `;
    const result = await suiteqlQuery(query);
    const row = result?.items?.[0] || {};
    return {
      thisMonth: {
        total: parseFloat(row.this_month || '0') || 0,
        invoices: parseInt(row.this_month_invoices || '0', 10) || 0,
      },
      lastMonthToDate: { total: parseFloat(row.last_month_to_date || '0') || 0 },
      lastMonthFull: { total: parseFloat(row.last_month_full || '0') || 0 },
    };
  },
  ['reports', 'invoiced-summary'],
  { revalidate: CACHE_TTL.MEDIUM, tags: ['netsuite:invoices'] },
);

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    // Same day-of-month window last month; clamp to the month's last day.
    const lastMonthSameDay = new Date(Date.UTC(
      lastMonthStart.getUTCFullYear(), lastMonthStart.getUTCMonth(),
      Math.min(now.getUTCDate(), lastMonthEnd.getUTCDate()),
    ));

    const summary = await fetchInvoicedSummary(
      ymd(monthStart), ymd(lastMonthStart), ymd(lastMonthSameDay), ymd(lastMonthEnd),
    );
    return NextResponse.json({ success: true, ...summary });
  } catch (err: any) {
    console.error('invoiced-summary error:', err);
    return NextResponse.json({ error: err?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
