import { getIncomeStatementFromRestlet, getCollectionsFromRestlet, type RestletPnlRow } from './netsuite';
import { revenuePeriodBounds } from './revenue-summary';
import { chicagoDay } from './exec-metrics';

/**
 * P&L unlock (R5-5): GM%, NP%, payroll, and labor-as-%-of-revenue from the
 * financials RESTlet's incomeStatement mode — numbers the SuiteQL role
 * provably cannot compute (it can't read the account table or payment
 * records). Closed months are reliable; the current month is directional —
 * that labeling is a hard requirement, not polish.
 *
 * Sign convention: transaction-search SUMs usually come back credit-normal
 * (income negative, expenses positive). summarizePnl detects orientation
 * from the income rows and normalizes so income/cogs/expense all read as
 * positive magnitudes; contra accounts keep their relative sign.
 */

export interface PnlSummary {
  income: number;
  cogs: number;
  expense: number; // operating expense EXCLUDING the payroll group
  payroll: number;
  otherIncome: number;
  otherExpense: number;
  grossMargin: number;
  grossMarginPct: number | null;
  netProfit: number;
  netProfitPct: number | null;
  laborPct: number | null; // payroll / income
  accountCount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Parse NETSUITE_PAYROLL_ACCOUNT_IDS ("123,456") — same idList style as the balance groups. */
export function payrollAccountIds(raw: string | undefined = process.env.NETSUITE_PAYROLL_ACCOUNT_IDS): Set<string> {
  return new Set((raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => /^\d{1,18}$/.test(s)));
}

export function summarizePnl(rows: RestletPnlRow[], payrollIds: Set<string>): PnlSummary {
  // Per-bucket orientation: each account-type bucket is normalized so its
  // TOTAL reads as a positive magnitude (income as revenue, cost buckets as
  // cost), with one flip applied to every row IN that bucket — so contra
  // accounts keep their relative sign inside the bucket, whichever sign
  // convention the search reports. Robust to both credit-normal and
  // report-normal results; the deploy runbook's verification step compares
  // against NetSuite's own income statement.
  const byType = (t: string) => rows.filter(r => r.accountType === t);
  const total = (list: RestletPnlRow[]) => list.reduce((s, r) => s + r.amount, 0);
  const flipOf = (list: RestletPnlRow[]) => (total(list) < 0 ? -1 : 1);

  const income = total(byType('Income')) * flipOf(byType('Income'));
  const cogs = total(byType('COGS')) * flipOf(byType('COGS'));
  const otherIncome = total(byType('OthIncome')) * flipOf(byType('OthIncome'));
  const otherExpense = total(byType('OthExpense')) * flipOf(byType('OthExpense'));

  // Expense splits into payroll vs other, but the flip comes from the WHOLE
  // bucket so the split can't disagree with itself.
  const expenseRows = byType('Expense');
  const expenseFlip = flipOf(expenseRows);
  let expense = 0, payroll = 0;
  for (const r of expenseRows) {
    const v = r.amount * expenseFlip;
    if (payrollIds.has(r.accountId)) payroll += v;
    else expense += v;
  }

  const grossMargin = income - cogs;
  const netProfit = income - cogs - expense - payroll + otherIncome - otherExpense;
  return {
    income: round2(income),
    cogs: round2(cogs),
    expense: round2(expense),
    payroll: round2(payroll),
    otherIncome: round2(otherIncome),
    otherExpense: round2(otherExpense),
    grossMargin: round2(grossMargin),
    grossMarginPct: income > 0 ? round2((grossMargin / income) * 100) : null,
    netProfit: round2(netProfit),
    netProfitPct: income > 0 ? round2((netProfit / income) * 100) : null,
    laborPct: income > 0 ? round2((payroll / income) * 100) : null,
    accountCount: rows.length,
  };
}

export interface PnlPeriod {
  label: string;
  from: string;
  to: string;
  /** true = the period contains today — numbers are directional, not closed. */
  directional: boolean;
  pnl: PnlSummary | null;
  collections: { total: number; count: number } | null;
  error: string | null;
}

/**
 * The /pnl payload: month-to-date (directional), last full month, and
 * year-to-date. Each period fails independently; a stale-deployment error
 * surfaces verbatim so the UI can show the redeploy hint.
 */
export async function loadPnlPeriods(): Promise<{ periods: PnlPeriod[]; payrollConfigured: boolean }> {
  const today = chicagoDay();
  const b = revenuePeriodBounds(today);
  const lastMonthEnd = (() => {
    const [y, m] = b.monthStart.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 0)); // day 0 of this month = last day of previous
    return d.toISOString().slice(0, 10);
  })();
  const ids = payrollAccountIds();

  const defs = [
    { label: 'Month to date', from: b.monthStart, to: today, directional: true },
    { label: 'Last month', from: b.lastMonthStart, to: lastMonthEnd, directional: false },
    { label: 'Year to date', from: b.yearStart, to: today, directional: true },
  ];

  const periods = await Promise.all(defs.map(async (d): Promise<PnlPeriod> => {
    const [pnlRes, colRes] = await Promise.all([
      getIncomeStatementFromRestlet(d.from, d.to),
      getCollectionsFromRestlet(d.from, d.to),
    ]);
    return {
      ...d,
      pnl: pnlRes.success && pnlRes.rows ? summarizePnl(pnlRes.rows, ids) : null,
      collections: colRes.success ? { total: Math.abs(colRes.total || 0), count: colRes.count || 0 } : null,
      error: pnlRes.success ? (colRes.success ? null : colRes.error || null) : pnlRes.error || null,
    };
  }));

  return { periods, payrollConfigured: ids.size > 0 };
}
