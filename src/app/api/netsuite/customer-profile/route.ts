import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { safeIntId, SqlSafeError } from '@/lib/sql-safe';
import { suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netsuite/customer-profile?customerId=<NetSuite internal id>
 *
 * Credit terms/limit plus a 12-month invoiced-sales series for one customer —
 * the "QuickBooks-style" header facts on the Customer Record page.
 *
 *  - terms / creditLimit / nsBalance come from the customer table. Column and
 *    BUILTIN.DF availability varies by role, so the query degrades field by
 *    field instead of failing the whole response (the balance field and
 *    BUILTIN.DF are the shaky ones — see vendor-po-sync's DF fallback).
 *  - months: the last 12 calendar months (zero-filled, oldest first) of
 *    invoiced totals, from CustInvc headers regardless of paid status.
 *
 * Response: { success, terms, creditLimit, nsBalance, months: [{ month:
 * 'YYYY-MM', total }] } — profile fields null when unavailable.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const customerId = safeIntId(req.nextUrl.searchParams.get('customerId'), 'customerId');

    // ── Terms / credit limit / NetSuite balance, degrading per column ──────
    let terms: string | null = null;
    let creditLimit: number | null = null;
    let nsBalance: number | null = null;
    const attempts = [
      `SELECT cu.creditlimit, cu.balance, BUILTIN.DF(cu.terms) AS terms FROM customer cu WHERE cu.id = ${customerId}`,
      `SELECT cu.creditlimit, cu.balance FROM customer cu WHERE cu.id = ${customerId}`,
      `SELECT cu.creditlimit, BUILTIN.DF(cu.terms) AS terms FROM customer cu WHERE cu.id = ${customerId}`,
      `SELECT cu.creditlimit FROM customer cu WHERE cu.id = ${customerId}`,
    ];
    for (const q of attempts) {
      try {
        const row = (await suiteqlQuery(q, 1, 0))?.items?.[0];
        if (row) {
          if (row.creditlimit != null && row.creditlimit !== '') creditLimit = Number(row.creditlimit) || null;
          if (row.balance != null && row.balance !== '') nsBalance = Number(row.balance);
          if (row.terms) terms = String(row.terms);
        }
        break;
      } catch { /* next, simpler shape */ }
    }

    // ── 12-month invoiced series (calendar months incl. the current one) ───
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const startIso = start.toISOString().slice(0, 10);
    const rows = await suiteqlQueryAll(`
      SELECT t.trandate, t.foreigntotal
      FROM transaction t
      WHERE t.type = 'CustInvc' AND t.entity = ${customerId}
        AND t.trandate >= TO_DATE('${startIso}', 'YYYY-MM-DD')
      ORDER BY t.id
    `);

    const monthKey = (d: string): string | null => {
      const iso = /^\d{4}-\d{2}/.test(d) ? d : (() => {
        const m = d.match(/^(\d{1,2})\/\d{1,2}\/(\d{4})$/);
        return m ? `${m[2]}-${m[1].padStart(2, '0')}` : '';
      })();
      return iso ? iso.slice(0, 7) : null;
    };

    const totals: Record<string, number> = {};
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      totals[d.toISOString().slice(0, 7)] = 0;
    }
    for (const r of rows) {
      const key = r.trandate ? monthKey(String(r.trandate)) : null;
      if (key && key in totals) totals[key] += Number(r.foreigntotal) || 0;
    }
    const months = Object.entries(totals).map(([month, total]) => ({ month, total: Math.round(total * 100) / 100 }));

    return NextResponse.json({ success: true, terms, creditLimit, nsBalance, months });
  } catch (e: any) {
    if (e instanceof SqlSafeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
