import type { SupabaseClient } from '@supabase/supabase-js';
import { getIncomeStatementFromRestlet } from '@/lib/netsuite';
import { payrollAccountIds, summarizePnl, type PnlSummary } from '@/lib/pnl';
import { chicagoDay } from '@/lib/exec-metrics';
import { fetchAllRows } from '@/lib/fetch-all';
import { readLedgerSettings } from '@/lib/ledger/pdf-gate';

/**
 * Financial history: one monthly P&L across both systems.
 *
 * Owner goal (2026-09-24): NetSuite holds about 2.5 years, too little to read
 * trends from, so QuickBooks' months carry the history back. Each month comes
 * from exactly ONE system: QuickBooks before the confirmed cutover, NetSuite
 * from the cutover month on. Months where both were live (NetSuite started in
 * April 2023) are QuickBooks', because the owner set the cutover as the day
 * NetSuite became the record, so adding both would count the overlap twice.
 *
 * Only top-level totals are compared (income, cost of goods, expenses, other,
 * net). The two charts of accounts differ, so account-level comparison needs
 * a mapping this report does not pretend to have.
 *
 * Sources:
 *   QuickBooks  the monthly accrual P&L snapshots the importer stored
 *               (`ledger_report_snapshots`, summary labels from
 *               src/lib/quickbooks/reports.ts). Read as stored, never refetched.
 *   NetSuite    the financials RESTlet's incomeStatement (src/lib/pnl.ts),
 *               cached per closed month in the same table under source
 *               'netsuite', because 30+ RESTlet calls per page view would trip
 *               NetSuite's concurrency limit. A month fetched before its books
 *               could have closed is refetched; the current month is always
 *               live and marked directional.
 */

export type HistorySource = 'quickbooks' | 'netsuite';

export interface MonthPnl {
  /** YYYY-MM */
  month: string;
  source: HistorySource;
  income: number;
  cogs: number;
  grossProfit: number;
  /** Operating expenses, payroll included (QuickBooks doesn't split it). */
  expenses: number;
  /** Other income minus other expense. */
  otherNet: number;
  netIncome: number;
  /** The month contains today: books open, numbers still moving. */
  directional: boolean;
}

export interface YearPnl {
  year: number;
  income: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  otherNet: number;
  netIncome: number;
  grossMarginPct: number | null;
  netMarginPct: number | null;
  /** Months with a P&L in this year (fewer than 12 = partial year). */
  months: number;
  sources: HistorySource[];
  directional: boolean;
}

export interface FinancialHistory {
  months: MonthPnl[];
  years: YearPnl[];
  cutover: string | null;
  /** Closed NetSuite months not fetched yet (time budget); ask again. */
  netsuitePending: number;
  errors: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');

/** Every YYYY-MM from `from` through `to`, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (!y || !m || !ty || !tm) return out;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${pad(last)}` };
}

/**
 * A QuickBooks monthly P&L summary as a month. QuickBooks omits a total it
 * has nothing to put under (no COGS accounts, a month with no activity), so a
 * missing label is zero, and Gross Profit falls back to income minus COGS.
 */
export function qboSummaryToMonth(month: string, summary: Record<string, unknown> | null | undefined): MonthPnl {
  const num = (k: string): number | null => {
    const v = summary?.[k];
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const income = num('Total Income') ?? 0;
  const cogs = num('Total Cost of Goods Sold') ?? 0;
  const grossProfit = num('Gross Profit') ?? income - cogs;
  const expenses = num('Total Expenses') ?? 0;
  const netIncome = num('Net Income') ?? grossProfit - expenses;
  return {
    month, source: 'quickbooks',
    income: round2(income), cogs: round2(cogs), grossProfit: round2(grossProfit),
    expenses: round2(expenses), otherNet: round2(netIncome - (grossProfit - expenses)),
    netIncome: round2(netIncome), directional: false,
  };
}

export function nsSummaryToMonth(month: string, s: PnlSummary, directional: boolean): MonthPnl {
  return {
    month, source: 'netsuite',
    income: s.income, cogs: s.cogs, grossProfit: s.grossMargin,
    expenses: round2(s.expense + s.payroll), otherNet: round2(s.otherIncome - s.otherExpense),
    netIncome: s.netProfit, directional,
  };
}

export function yearTotals(months: MonthPnl[]): YearPnl[] {
  const byYear = new Map<number, MonthPnl[]>();
  for (const m of months) {
    const y = Number(m.month.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(m);
  }
  return [...byYear.entries()].sort(([a], [b]) => a - b).map(([year, list]) => {
    const sum = (k: 'income' | 'cogs' | 'grossProfit' | 'expenses' | 'otherNet' | 'netIncome') =>
      round2(list.reduce((s, m) => s + m[k], 0));
    const income = sum('income');
    const grossProfit = sum('grossProfit');
    const netIncome = sum('netIncome');
    const pct = (n: number) => (income ? Math.round((n / income) * 1000) / 10 : null);
    return {
      year,
      income, cogs: sum('cogs'), grossProfit, expenses: sum('expenses'), otherNet: sum('otherNet'), netIncome,
      grossMarginPct: pct(grossProfit),
      netMarginPct: pct(netIncome),
      months: list.length,
      sources: [...new Set(list.map(m => m.source))],
      directional: list.some(m => m.directional),
    };
  });
}

/**
 * Was this NetSuite month fetched early enough that its books may still have
 * been open? Month-end close adjustments land for weeks after the month, so a
 * copy taken inside that window is refreshed rather than trusted forever.
 */
export function netsuiteMonthStale(month: string, fetchedAt: string | null, closeDays = 45): boolean {
  if (!fetchedAt) return true;
  const { end } = monthBounds(month);
  const settled = Date.parse(`${end}T00:00:00Z`) + closeDays * 86_400_000;
  return Date.parse(fetchedAt) < settled;
}

const netsuiteExternalId = (month: string) => {
  const { start, end } = monthBounds(month);
  // Same shape as reportExternalId (src/lib/quickbooks/reports.ts).
  return `ProfitAndLoss:accrual:${start}:${end}:Total`;
};

type SnapshotRow = { period_start: string; summary: Record<string, unknown> | null; fetched_at: string | null };

async function readSnapshots(service: SupabaseClient, source: HistorySource, before?: string, from?: string): Promise<SnapshotRow[]> {
  const { data, error } = await fetchAllRows<SnapshotRow>((lo, hi) => {
    let q = service.from('ledger_report_snapshots')
      .select('period_start, summary, fetched_at')
      .eq('source', source)
      .eq('report_type', 'ProfitAndLoss')
      .eq('basis', 'accrual')
      .eq('period_kind', 'month')
      .eq('status', 'stored');
    if (before) q = q.lt('period_start', before);
    if (from) q = q.gte('period_start', from);
    return q.order('period_start').order('id').range(lo, hi);
  });
  if (error) throw new Error(`Could not read ${source} P&L snapshots: ${error.message}`);
  return data || [];
}

/**
 * The whole history, filling missing NetSuite months within `budgetMs`.
 * NetSuite calls run one at a time: this sits beside other RESTlet traffic
 * and must not be the reason SSS_REQUEST_LIMIT_EXCEEDED comes back.
 */
export async function loadFinancialHistory(service: SupabaseClient, opts: { budgetMs: number }): Promise<FinancialHistory> {
  const deadline = Date.now() + opts.budgetMs;
  const errors: string[] = [];
  const settings = await readLedgerSettings(service);
  const cutover = settings.cutover?.date || null;
  const today = chicagoDay();
  const thisMonth = today.slice(0, 7);
  const cutoverMonth = cutover ? cutover.slice(0, 7) : null;
  // No confirmed cutover means no QuickBooks months: never guess the seam.
  const netsuiteFrom = cutoverMonth || thisMonth;

  const months: MonthPnl[] = [];

  if (cutoverMonth) {
    const qbo = await readSnapshots(service, 'quickbooks', `${cutoverMonth}-01`);
    const qboMonths = qbo.map(r => qboSummaryToMonth(r.period_start.slice(0, 7), r.summary));
    // Leading months with no activity at all are before the company used
    // QuickBooks, not months with zero sales.
    const first = qboMonths.findIndex(m => m.income !== 0 || m.expenses !== 0 || m.cogs !== 0);
    if (first >= 0) months.push(...qboMonths.slice(first));
  }

  const stored = new Map<string, SnapshotRow>();
  for (const r of await readSnapshots(service, 'netsuite', undefined, `${netsuiteFrom}-01`)) {
    stored.set(r.period_start.slice(0, 7), r);
  }
  const payroll = payrollAccountIds();
  let pending = 0;
  for (const month of monthsBetween(netsuiteFrom, thisMonth)) {
    const directional = month === thisMonth;
    const have = stored.get(month);
    if (have?.summary && !directional && !netsuiteMonthStale(month, have.fetched_at)) {
      months.push(nsSummaryToMonth(month, have.summary as unknown as PnlSummary, false));
      continue;
    }
    if (Date.now() >= deadline) {
      // Out of time: show the older copy if there is one, and say more is coming.
      if (have?.summary && !directional) months.push(nsSummaryToMonth(month, have.summary as unknown as PnlSummary, false));
      pending++;
      continue;
    }
    const { start, end } = monthBounds(month);
    const res = await getIncomeStatementFromRestlet(start, directional ? today : end);
    if (!res.success || !res.rows) {
      errors.push(`NetSuite ${month}: ${res.error || 'no rows'}`);
      if (have?.summary && !directional) months.push(nsSummaryToMonth(month, have.summary as unknown as PnlSummary, false));
      continue;
    }
    const summary = summarizePnl(res.rows, payroll);
    months.push(nsSummaryToMonth(month, summary, directional));
    if (!directional) {
      const now = new Date().toISOString();
      const { error } = await service.from('ledger_report_snapshots').upsert({
        source: 'netsuite',
        external_id: netsuiteExternalId(month),
        report_type: 'ProfitAndLoss',
        basis: 'accrual',
        period_kind: 'month',
        period_start: start,
        period_end: end,
        summarize_by: 'Total',
        params: { from: start, to: end, action: 'incomeStatement' },
        payload: { rows: res.rows },
        summary,
        generated_at: now,
        fetched_at: now,
        status: 'stored',
        error: null,
      }, { onConflict: 'source,external_id' });
      if (error) errors.push(`Could not cache NetSuite ${month}: ${error.message}`);
    }
  }

  months.sort((a, b) => a.month.localeCompare(b.month));
  return { months, years: yearTotals(months), cutover, netsuitePending: pending, errors };
}
