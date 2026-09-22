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
  key: PnlPeriodKey;
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
 * The periods the Financials P&L band offers. Fiscal year = calendar year
 * (confirmed by the owner 2026-09-19); if that ever changes, `ytd` and
 * `last-year` are the two that move.
 */
export const PNL_PERIOD_KEYS = ['mtd', 'last-month', 'qtd', 'ytd', 'last-year'] as const;
export type PnlPeriodKey = typeof PNL_PERIOD_KEYS[number];
export const DEFAULT_PNL_PERIOD: PnlPeriodKey = 'last-month';

export function isPnlPeriodKey(v: unknown): v is PnlPeriodKey {
  return typeof v === 'string' && (PNL_PERIOD_KEYS as readonly string[]).includes(v);
}

export interface PnlPeriodDef {
  key: PnlPeriodKey;
  label: string;
  from: string;
  to: string;
  directional: boolean;
}

/**
 * Date bounds for each selectable period, relative to `today` (Chicago).
 * `directional` means the range contains today, so the books aren't closed
 * and the numbers still move — the band must label those, which is a hard
 * requirement carried over from R5-5, not polish.
 */
export function pnlPeriodDefs(today: string): Record<PnlPeriodKey, PnlPeriodDef> {
  const b = revenuePeriodBounds(today);
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  // Day 0 of this month = the last day of the previous month.
  const lastMonthEnd = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);

  return {
    'mtd': { key: 'mtd', label: 'This month', from: b.monthStart, to: today, directional: true },
    'last-month': { key: 'last-month', label: 'Last month', from: b.lastMonthStart, to: lastMonthEnd, directional: false },
    'qtd': { key: 'qtd', label: 'Quarter to date', from: b.quarterStart, to: today, directional: true },
    'ytd': { key: 'ytd', label: 'Year to date', from: b.yearStart, to: today, directional: true },
    'last-year': { key: 'last-year', label: 'Last year', from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, directional: false },
  };
}

/**
 * The /pnl payload: ONE period, chosen by the caller. Loading a single
 * period rather than every period up front is deliberate — the previous
 * shape fired six RESTlet requests at once (three periods x P&L +
 * collections) and, together with the balances call on the same page, put
 * us over NetSuite's SuiteCloud concurrency limit, which rejects the
 * overflow with SSS_REQUEST_LIMIT_EXCEEDED. Two requests per view is well
 * inside it, and the user only ever looks at one period at a time.
 *
 * A stale-deployment error surfaces verbatim so the UI can show the
 * redeploy hint (docs/pnl-restlet-deploy.md) rather than a bare $0.
 */
export async function loadPnlPeriod(key: PnlPeriodKey = DEFAULT_PNL_PERIOD): Promise<{
  period: PnlPeriod;
  options: { key: PnlPeriodKey; label: string }[];
  payrollConfigured: boolean;
}> {
  const defs = pnlPeriodDefs(chicagoDay());
  const def = defs[key] ?? defs[DEFAULT_PNL_PERIOD];
  const ids = payrollAccountIds();

  const [pnlRes, colRes] = await Promise.all([
    getIncomeStatementFromRestlet(def.from, def.to),
    getCollectionsFromRestlet(def.from, def.to),
  ]);

  return {
    period: {
      ...def,
      pnl: pnlRes.success && pnlRes.rows ? summarizePnl(pnlRes.rows, ids) : null,
      collections: colRes.success ? { total: Math.abs(colRes.total || 0), count: colRes.count || 0 } : null,
      error: pnlRes.success ? (colRes.success ? null : colRes.error || null) : pnlRes.error || null,
    },
    options: PNL_PERIOD_KEYS.map(k => ({ key: k, label: defs[k].label })),
    payrollConfigured: ids.size > 0,
  };
}
