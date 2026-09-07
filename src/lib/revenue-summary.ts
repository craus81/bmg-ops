import { suiteqlQuery } from './netsuite';
import { chicagoDay } from './exec-metrics';

/**
 * Netted revenue periods for the CEO view (R4-4): CustInvc minus CustCred
 * over non-tax lines. Uniform `-tl.netamount` handles both — invoice line
 * netamounts come back negative (so the negation is positive revenue) and
 * credit-memo lines positive (so the negation subtracts), the same sign
 * convention /api/reports/invoiced-summary established for invoices.
 */

export interface RevenuePeriods {
  mtd: number;
  lastMonthToDate: number;
  ytd: number;
  qtd: number;
  trailing12: number;
  monthly: { month: string; total: number }[]; // oldest first, 13 months
}

/** Period boundaries off a YYYY-MM-DD calendar date. Pure — tested. */
export function revenuePeriodBounds(today: string): {
  monthStart: string; lastMonthStart: string; lastMonthSameDay: string;
  quarterStart: string; yearStart: string; trailing12Start: string; chartStart: string;
} {
  const [y, m, d] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const monthStart = `${y}-${pad(m)}-01`;
  const lm = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const lastMonthStart = `${lm.y}-${pad(lm.m)}-01`;
  // Clamp same-day for short months (Mar 31 → Feb 28/29).
  const lmDays = new Date(Date.UTC(lm.m === 12 ? lm.y + 1 : lm.y, lm.m === 12 ? 0 : lm.m, 0)).getUTCDate();
  const lastMonthSameDay = `${lm.y}-${pad(lm.m)}-${pad(Math.min(d, lmDays))}`;
  const qMonth = m - ((m - 1) % 3);
  const quarterStart = `${y}-${pad(qMonth)}-01`;
  const yearStart = `${y}-01-01`;
  const t12 = m === 12 ? { y, m: 1 } : { y: y - 1, m: m + 1 };
  const trailing12Start = `${t12.y}-${pad(t12.m)}-01`;
  let cy = y, cm = m - 12;
  if (cm <= 0) { cm += 12; cy -= 1; }
  const chartStart = `${cy}-${pad(cm)}-01`;
  return { monthStart, lastMonthStart, lastMonthSameDay, quarterStart, yearStart, trailing12Start, chartStart };
}

export async function loadRevenuePeriods(): Promise<RevenuePeriods> {
  const b = revenuePeriodBounds(chicagoDay());
  const base = `
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    WHERE t.type IN ('CustInvc', 'CustCred')
      AND tl.mainline = 'F' AND tl.taxline = 'F'
      AND t.trandate >= TO_DATE('${b.chartStart}', 'YYYY-MM-DD')`;
  const signed = '-tl.netamount';
  const between = (from: string, to?: string) =>
    `CASE WHEN t.trandate >= TO_DATE('${from}', 'YYYY-MM-DD')${to ? ` AND t.trandate <= TO_DATE('${to}', 'YYYY-MM-DD')` : ''} THEN ${signed} ELSE 0 END`;

  const periods = await suiteqlQuery(`
    SELECT
      SUM(${between(b.monthStart)}) AS mtd,
      SUM(${between(b.lastMonthStart, b.lastMonthSameDay)}) AS last_mtd,
      SUM(${between(b.yearStart)}) AS ytd,
      SUM(${between(b.quarterStart)}) AS qtd,
      SUM(${between(b.trailing12Start)}) AS t12
    ${base}`);
  const p = periods?.items?.[0] || {};

  const monthly = await suiteqlQuery(`
    SELECT TO_CHAR(t.trandate, 'YYYY-MM') AS month, SUM(${signed}) AS total
    ${base}
    GROUP BY TO_CHAR(t.trandate, 'YYYY-MM')
    ORDER BY TO_CHAR(t.trandate, 'YYYY-MM')`);

  const num = (v: unknown) => Math.round((parseFloat(String(v ?? 0)) || 0) * 100) / 100;
  return {
    mtd: num(p.mtd),
    lastMonthToDate: num(p.last_mtd),
    ytd: num(p.ytd),
    qtd: num(p.qtd),
    trailing12: num(p.t12),
    monthly: (monthly?.items || []).map((r: any) => ({ month: String(r.month), total: num(r.total) })),
  };
}
