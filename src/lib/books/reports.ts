import { COPY_FROM, monthsBetween, toCents } from './netsuite-gl';
import { retainedEarningsAccount, type TbAccount, type TbAmount, type TbTotals } from './trial-balance';

/**
 * Reports from FleetSuite's own books (docs/books.md, "Reports"): the profit
 * and loss for any months from January 2025, and the balance sheet and trial
 * balance at a month's end, each line next to NetSuite's.
 *
 * FleetSuite's side is its journal, summed per account and month by
 * migration 396's gl_books_totals; NetSuite's is NetSuite's own totals
 * (migration 361), as the trial balance check reads them. FleetSuite's books
 * post from January 2025, so both sides start from NetSuite's balances
 * before then (the starting entry), and anything FleetSuite's journal holds
 * dated earlier adds to its side. Laid out as NetSuite's reports are:
 * sections by account type, each account under its parent with a total for
 * the parent, earlier years' net income in retained earnings and this
 * year's as net income. Amounts are whole cents as each report shows them:
 * on the profit and loss and the balance sheet, income, liabilities and
 * equity are positive; on the trial balance, debits are.
 */

export interface ReportAccount extends TbAccount {
  id: string;
  parent_id: string | null;
}

/** FleetSuite's journal on one account in one month (gl_books_totals). */
export interface ReportAmount {
  /** The account's NetSuite id, or 'fs:<id>' for one NetSuite doesn't have. */
  account: string;
  /** 'YYYY-MM-01'. */
  month: string;
  debit: string;
  credit: string;
}

export interface ReportData {
  /** The company these amounts are for; picks its retained earnings account. */
  company: string;
  accounts: ReportAccount[];
  /** NetSuite's balances before 2025: the starting entry both sides share. */
  opening: TbAmount[];
  /** NetSuite's own movements per account and month. */
  netsuite: TbAmount[];
  /** FleetSuite's journal per account and month. */
  fleetsuite: ReportAmount[];
}

export const REPORT_KINDS = ['profit_and_loss', 'balance_sheet', 'trial_balance'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/**
 * What a report covers, as NetSuite's reports have it: the profit and loss,
 * the months from `from` through `to` (`to` alone without a `from`, or with
 * one after it); the balance sheet and trial balance, the end of `to`.
 * Months are 'YYYY-MM-01'.
 */
export interface ReportRange {
  from?: string;
  to: string;
}

export interface ReportLine {
  /**
   * section: a part of the report (Income, Assets, Current liabilities);
   * heading: an account with accounts under it and nothing of its own;
   * account: an account's own amount, or retained earnings or net income;
   * total: a section's total, or a parent account's with what's under it.
   */
  kind: 'section' | 'heading' | 'account' | 'total';
  depth: number;
  label: string;
  number?: string | null;
  /** An account's key: its NetSuite id, or 'fs:<id>'. */
  account?: string;
  /** False for a NetSuite account FleetSuite's chart doesn't have yet. */
  inChart?: boolean;
  /** Retained earnings or net income on the balance sheet: a line that's no account. */
  derived?: true;
  /** A total over sections: gross profit, net income, total assets and the like. */
  grand?: true;
  /** Null on a section or heading. */
  fleetsuite: number | null;
  netsuite: number | null;
}

export interface Report {
  lines: ReportLine[];
  /** Account lines (retained earnings and net income among them) whose two sides differ. */
  differing: number;
  /** The trial balance's debits and credits, each side. */
  totals?: { fleetsuite: TbTotals; netsuite: TbTotals };
}

export interface ReportMonth {
  /** 'YYYY-MM-01'. */
  month: string;
  matches: boolean;
  differing: number;
}

const SIDES = ['fleetsuite', 'netsuite'] as const;
type Side = (typeof SIDES)[number];
type Pair = Record<Side, number>;

const ZERO: Pair = { fleetsuite: 0, netsuite: 0 };
const plus = (a: Pair, b: Pair): Pair => ({ fleetsuite: a.fleetsuite + b.fleetsuite, netsuite: a.netsuite + b.netsuite });
const minus = (a: Pair, b: Pair): Pair => ({ fleetsuite: a.fleetsuite - b.fleetsuite, netsuite: a.netsuite - b.netsuite });
// `|| 0` keeps a flipped zero from reading as -0.
const times = (sign: number, a: Pair): Pair => ({ fleetsuite: sign * a.fleetsuite || 0, netsuite: sign * a.netsuite || 0 });
const isZero = (a: Pair) => !a.fleetsuite && !a.netsuite;

const net = (a: { debit: string; credit: string }) => toCents(a.debit) - toCents(a.credit);
const keyOf = (a: ReportAccount) => a.netsuite_account_id ?? `fs:${a.id}`;
const yearStart = (month: string) => `${month.slice(0, 4)}-01-01`;
const collator = new Intl.Collator('en', { numeric: true });

/** The data, indexed by account key, once for every month a page asks about. */
interface Books {
  data: ReportData;
  chart: Map<string, ReportAccount>;
  opening: Map<string, number>;
  moves: Record<Side, Map<string, Array<[string, number]>>>;
  /** Every account the chart, the starting entry or either side has. */
  keys: string[];
}

function books(data: ReportData): Books {
  const chart = new Map(data.accounts.map((a) => [keyOf(a), a]));
  const opening = new Map<string, number>();
  for (const r of data.opening) opening.set(r.netsuite_account_id, (opening.get(r.netsuite_account_id) ?? 0) + net(r));
  const moves: Books['moves'] = { fleetsuite: new Map(), netsuite: new Map() };
  const add = (side: Side, key: string, month: string, cents: number) => {
    const list = moves[side].get(key) ?? [];
    list.push([month, cents]);
    moves[side].set(key, list);
  };
  for (const r of data.netsuite) if (r.month) add('netsuite', r.netsuite_account_id, r.month, net(r));
  for (const r of data.fleetsuite) add('fleetsuite', r.account, r.month, net(r));
  const keys = new Set([...chart.keys(), ...opening.keys(), ...moves.fleetsuite.keys(), ...moves.netsuite.keys()]);
  return { data, chart, opening, moves, keys: [...keys] };
}

/** What one side moved on an account in the months from `from` through `to`. */
function moved(b: Books, side: Side, key: string, from: string, to: string): number {
  let cents = 0;
  for (const [month, c] of b.moves[side].get(key) ?? []) if (month >= from && month <= to) cents += c;
  return cents;
}

/** An account's balance, debit positive, before `month` begins: the starting entry and every earlier month. */
function before(b: Books, side: Side, key: string, month: string): number {
  let cents = b.opening.get(key) ?? 0;
  for (const [m, c] of b.moves[side].get(key) ?? []) if (m < month) cents += c;
  return cents;
}

const pairOf = (f: (side: Side) => number): Pair => ({ fleetsuite: f('fleetsuite'), netsuite: f('netsuite') });

/** Balance at the end of `month`, debit positive. */
const balanceAt = (b: Books, key: string, month: string) => pairOf((side) => before(b, side, key, month) + moved(b, side, key, month, month));

const isIncomeStatement = (b: Books, key: string) => b.chart.get(key)?.statement === 'income_statement';

interface Block {
  lines: ReportLine[];
  total: Pair;
}

const EMPTY: Block = { lines: [], total: ZERO };

const sortAccounts = (list: ReportAccount[]) => [...list].sort((x, y) =>
  Number(x.number === null) - Number(y.number === null)
  || collator.compare(x.number ?? '', y.number ?? '')
  || collator.compare(x.name, y.name));

/**
 * The chart's accounts of some types, each under its parent when the parent
 * is of those types too, with a total for every parent that has accounts
 * showing under it. An account with nothing either side doesn't show, nor
 * does a parent with nothing of its own or under it.
 */
function accountBlock(b: Books, types: readonly string[], value: (key: string) => Pair, depth: number): Block {
  const members = b.data.accounts.filter((a) => types.includes(a.account_type));
  const ids = new Set(members.map((a) => a.id));
  const children = new Map<string, ReportAccount[]>();
  const roots: ReportAccount[] = [];
  for (const a of members) {
    if (a.parent_id && a.parent_id !== a.id && ids.has(a.parent_id)) children.set(a.parent_id, [...(children.get(a.parent_id) ?? []), a]);
    else roots.push(a);
  }

  const seen = new Set<string>();
  const render = (a: ReportAccount, level: number): Block => {
    if (seen.has(a.id)) return EMPTY;
    seen.add(a.id);
    const own = value(keyOf(a));
    const under = sortAccounts(children.get(a.id) ?? []).map((c) => render(c, level + 1)).filter((c) => c.lines.length);
    const line: ReportLine = { kind: 'account', depth: level, label: a.name, number: a.number, account: keyOf(a), inChart: true, ...own };
    if (!under.length) return isZero(own) ? EMPTY : { lines: [line], total: own };
    const total = under.reduce((sum, c) => plus(sum, c.total), own);
    return {
      lines: [
        isZero(own) ? { kind: 'heading', depth: level, label: a.name, number: a.number, fleetsuite: null, netsuite: null } : line,
        ...under.flatMap((c) => c.lines),
        { kind: 'total', depth: level, label: `Total ${a.name}`, ...total },
      ],
      total,
    };
  };

  const blocks = sortAccounts(roots).map((a) => render(a, depth));
  // An account whose parents loop back to it has no root; it shows at the top.
  for (const a of sortAccounts(members)) if (!seen.has(a.id)) blocks.push(render(a, depth));
  return { lines: blocks.flatMap((x) => x.lines), total: blocks.reduce((sum, x) => plus(sum, x.total), ZERO) };
}

/** A part of the report: its heading, what's in it and its total, or nothing when nothing in it shows. */
function section(label: string, total: string, depth: number, parts: Block[]): Block {
  const sum = parts.reduce((s, p) => plus(s, p.total), ZERO);
  const lines = parts.flatMap((p) => p.lines);
  if (!lines.length) return { lines: [], total: sum };
  return {
    lines: [{ kind: 'section', depth, label, fleetsuite: null, netsuite: null }, ...lines, { kind: 'total', depth, label: total, ...sum }],
    total: sum,
  };
}

const grand = (label: string, amount: Pair, depth = 0): ReportLine => ({ kind: 'total', depth, label, grand: true, ...amount });

/**
 * NetSuite accounts the chart doesn't have yet: a report can't place them,
 * so they show apart at its end, debit positive.
 */
function notInChart(b: Books, value: (key: string) => Pair): ReportLine[] {
  const lines: ReportLine[] = b.keys
    .filter((k) => !b.chart.has(k))
    .map((k) => ({ key: k, amount: value(k) }))
    .filter((x) => !isZero(x.amount))
    .sort((x, y) => collator.compare(x.key, y.key))
    .map((x) => ({ kind: 'account', depth: 1, label: `NetSuite account ${x.key}`, account: x.key, inChart: false, ...x.amount }));
  return lines.length ? [{ kind: 'section', depth: 0, label: 'Not in the chart of accounts yet', fleetsuite: null, netsuite: null }, ...lines] : [];
}

const counted = (lines: ReportLine[]) =>
  lines.filter((l) => l.kind === 'account' && l.fleetsuite !== l.netsuite).length;

/** The profit and loss for the months from `from` through `to`, laid out as NetSuite's income statement. */
function profitAndLossOf(b: Books, from: string, to: string): Report {
  const value = (sign: number) => (key: string) => times(sign, pairOf((side) => moved(b, side, key, from, to)));
  const part = (label: string, types: string[], sign: number) =>
    section(label, `Total ${label.toLowerCase()}`, 0, [accountBlock(b, types, value(sign), 1)]);

  const income = part('Income', ['income'], -1);
  const cost = part('Cost of sales', ['cost_of_goods_sold'], 1);
  const gross = minus(income.total, cost.total);
  const expense = part('Expense', ['expense'], 1);
  const ordinary = minus(gross, expense.total);
  const otherIncome = part('Other income', ['other_income'], -1);
  const otherExpense = part('Other expense', ['other_expense'], 1);
  const other = minus(otherIncome.total, otherExpense.total);
  const hasOther = otherIncome.lines.length > 0 || otherExpense.lines.length > 0;

  const lines = [
    ...income.lines,
    ...cost.lines,
    grand('Gross profit', gross),
    ...expense.lines,
    grand('Net ordinary income', ordinary),
    ...(hasOther ? [...otherIncome.lines, ...otherExpense.lines, grand('Net other income', other)] : []),
    grand('Net income', plus(ordinary, other)),
    ...notInChart(b, (key) => pairOf((side) => moved(b, side, key, from, to))),
  ];
  return { lines, differing: counted(lines) };
}

/** The balance sheet at the end of `month`, laid out as NetSuite's. */
function balanceSheetOf(b: Books, month: string): Report {
  const start = yearStart(month);
  const asset = (key: string) => balanceAt(b, key, month);
  const owed = (key: string) => times(-1, balanceAt(b, key, month));

  // Earlier years' net income, and this year's to the month's end, debit positive.
  const incomeKeys = b.keys.filter((k) => isIncomeStatement(b, k));
  const earlier = incomeKeys.reduce((sum, k) => plus(sum, pairOf((side) => before(b, side, k, start))), ZERO);
  const thisYear = incomeKeys.reduce((sum, k) => plus(sum, pairOf((side) => moved(b, side, k, start, month))), ZERO);
  const reAccount = retainedEarningsAccount(b.data.accounts, b.data.company);
  const reKey = reAccount ? keyOf(reAccount) : null;
  const equityValue = (key: string) => (key === reKey ? times(-1, plus(balanceAt(b, key, month), earlier)) : owed(key));

  const part = (label: string, depth: number, types: string[], value: (key: string) => Pair) =>
    section(label, `Total ${label.toLowerCase()}`, depth, [accountBlock(b, types, value, depth + 1)]);

  const current = section('Current assets', 'Total current assets', 1, [
    part('Bank', 2, ['bank'], asset),
    part('Accounts receivable', 2, ['accounts_receivable'], asset),
    part('Other current assets', 2, ['other_current_asset', 'unbilled_receivable', 'deferred_expense'], asset),
  ]);
  const fixed = part('Fixed assets', 1, ['fixed_asset'], asset);
  const otherAssets = part('Other assets', 1, ['other_asset'], asset);
  const assets = plus(plus(current.total, fixed.total), otherAssets.total);

  const currentOwed = section('Current liabilities', 'Total current liabilities', 1, [
    part('Accounts payable', 2, ['accounts_payable'], owed),
    part('Credit card', 2, ['credit_card'], owed),
    part('Other current liabilities', 2, ['other_current_liability', 'deferred_revenue'], owed),
  ]);
  const longTerm = part('Long term liabilities', 1, ['long_term_liability'], owed);
  const liabilities = plus(currentOwed.total, longTerm.total);

  const derived = (label: string, amount: Pair): Block =>
    (isZero(amount) ? EMPTY : { lines: [{ kind: 'account', depth: 2, label, derived: true, ...amount }], total: amount });
  const equity = section('Equity', 'Total equity', 1, [
    accountBlock(b, ['equity'], equityValue, 2),
    reAccount ? EMPTY : derived('Retained earnings (net income of earlier years)', times(-1, earlier)),
    derived('Net income', times(-1, thisYear)),
  ]);

  const lines: ReportLine[] = [
    { kind: 'section', depth: 0, label: 'Assets', fleetsuite: null, netsuite: null },
    ...current.lines,
    ...fixed.lines,
    ...otherAssets.lines,
    grand('Total assets', assets),
    { kind: 'section', depth: 0, label: 'Liabilities and equity', fleetsuite: null, netsuite: null },
    ...currentOwed.lines,
    ...longTerm.lines,
    { kind: 'total', depth: 1, label: 'Total liabilities', ...liabilities },
    ...equity.lines,
    grand('Total liabilities and equity', plus(liabilities, equity.total)),
    ...notInChart(b, (key) => balanceAt(b, key, month)),
  ];
  return { lines, differing: counted(lines) };
}

/**
 * The trial balance at the end of `month`, as NetSuite's Trial Balance
 * report and the trial balance check lay it out: balance sheet accounts at
 * their balance, income and expenses for the year to date, earlier years'
 * net income in retained earnings; debit positive.
 */
function trialBalanceOf(b: Books, month: string): Report {
  const start = yearStart(month);
  const amounts = new Map<string, Pair>();
  let earlier = ZERO;
  for (const key of b.keys) {
    if (isIncomeStatement(b, key)) {
      earlier = plus(earlier, pairOf((side) => before(b, side, key, start)));
      amounts.set(key, pairOf((side) => moved(b, side, key, start, month)));
    } else {
      amounts.set(key, balanceAt(b, key, month));
    }
  }
  const reAccount = retainedEarningsAccount(b.data.accounts, b.data.company);
  if (reAccount) amounts.set(keyOf(reAccount), plus(amounts.get(keyOf(reAccount)) ?? ZERO, earlier));

  // Balance sheet accounts, then retained earnings on a line of its own, then income and expenses.
  const rows: Array<{ order: number; line: ReportLine }> = [...amounts]
    .filter(([, amount]) => !isZero(amount))
    .map(([key, amount]) => {
      const account = b.chart.get(key);
      return {
        order: isIncomeStatement(b, key) ? 2 : 0,
        line: {
          kind: 'account', depth: 0, label: account?.name ?? `NetSuite account ${key}`, number: account?.number ?? null,
          account: key, inChart: !!account, ...amount,
        },
      };
    });
  if (!reAccount && !isZero(earlier)) {
    rows.push({ order: 1, line: { kind: 'account', depth: 0, label: 'Retained earnings (net income of earlier years)', derived: true, ...earlier } });
  }

  const lines = rows
    .sort((x, y) => x.order - y.order
      || Number(x.line.number == null) - Number(y.line.number == null)
      || collator.compare(x.line.number ?? '', y.line.number ?? '')
      || collator.compare(x.line.label, y.line.label))
    .map((r) => r.line);
  const total = (side: Side): TbTotals => ({
    debit: lines.reduce((s, l) => s + Math.max(0, l[side] ?? 0), 0),
    credit: lines.reduce((s, l) => s + Math.max(0, -(l[side] ?? 0)), 0),
  });
  return { lines, differing: counted(lines), totals: { fleetsuite: total('fleetsuite'), netsuite: total('netsuite') } };
}

function reportOf(b: Books, kind: ReportKind, range: ReportRange): Report {
  if (kind === 'balance_sheet') return balanceSheetOf(b, range.to);
  if (kind === 'trial_balance') return trialBalanceOf(b, range.to);
  return profitAndLossOf(b, range.from && range.from <= range.to ? range.from : range.to, range.to);
}

/** One report: the profit and loss for the months of the range, or the balance sheet or trial balance at its end. */
export function report(data: ReportData, kind: ReportKind, range: ReportRange): Report {
  return reportOf(books(data), kind, range);
}

/**
 * For each month from January 2025 through `through`: does the report for
 * that month alone (its profit and loss, or the balance sheet or trial
 * balance at its end), as report() lays it out, match NetSuite's line for
 * line?
 */
export function reportMonths(data: ReportData, kind: ReportKind, through: string): ReportMonth[] {
  const b = books(data);
  return monthsBetween(COPY_FROM, through).map((month) => {
    const differing = reportOf(b, kind, { to: month }).differing;
    return { month, matches: differing === 0, differing };
  });
}

/** The latest month either side has, but never before `floor`. */
export function lastReportMonth(data: ReportData, floor: string): string {
  let last = floor;
  for (const r of [...data.netsuite, ...data.fleetsuite]) if (r.month && r.month > last) last = r.month;
  return last;
}
