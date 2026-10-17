import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import {
  lastReportMonth, report, reportMonths, type ReportAccount, type ReportAmount, type ReportData, type ReportLine,
} from './reports';
import { trialBalance, type TbAmount } from './trial-balance';

const INCOME_STATEMENT = new Set(['income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense']);
const account = (id: string, ns: string | null, number: string | null, name: string, type: string, extra: Partial<ReportAccount> = {}): ReportAccount => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: INCOME_STATEMENT.has(type) ? 'income_statement' : 'balance_sheet', parent_id: null, ...extra,
});

/** Made-up chart: Payroll is a parent of Wages and Payroll taxes; Shop supplies is FleetSuite's own. */
const ACCOUNTS: ReportAccount[] = [
  account('a10', '10', '1000', 'Checking', 'bank'),
  account('a12', '12', '1200', 'Receivables', 'accounts_receivable'),
  account('a13', '13', '1300', 'Inventory', 'other_current_asset'),
  account('a15', '15', '1500', 'Trucks', 'fixed_asset'),
  account('a20', '20', '2000', 'Payables', 'accounts_payable'),
  account('a21', '21', '2100', 'Chase card', 'credit_card'),
  account('a22', '22', '2200', 'Sales tax', 'other_current_liability'),
  account('a25', '25', '2500', 'Loan', 'long_term_liability'),
  account('a30', '30', '3000', 'Owner capital', 'equity'),
  account('a39', '39', '3900', 'Retained Earnings', 'equity'),
  account('a40', '40', '4000', 'Sales', 'income'),
  account('a50', '50', '5000', 'Cost of Goods Sold', 'cost_of_goods_sold'),
  account('a60', '60', '6000', 'Payroll', 'expense'),
  account('a61', '61', '6010', 'Wages', 'expense', { parent_id: 'a60' }),
  account('a62', '62', '6020', 'Payroll taxes', 'expense', { parent_id: 'a60' }),
  account('a65', '65', '6500', 'Rent', 'expense'),
  account('afs', null, '6900', 'Shop supplies', 'expense'),
  account('a80', '80', '8000', 'Interest income', 'other_income'),
  account('a90', '90', '9000', 'Bank fees', 'other_expense'),
];
const SHOP = 'fs:afs';

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const ns = (acct: string, month: string | undefined, cents: number): TbAmount => ({ netsuite_account_id: acct, ...sides(cents), ...(month ? { month } : {}) });
const fs = (acct: string, month: string, cents: number): ReportAmount => ({ account: acct, month, ...sides(cents) });
type Move = [string, number];

// Before 2025: 10,000 in the bank, 1,000 of stock, 5,000 of trucks, a 3,000
// loan, 9,000 of capital and 4,000 of net income (6,000 of sales less 2,000
// of wages).
const OPENING = [ns('10', undefined, 1000000), ns('13', undefined, 100000), ns('15', undefined, 500000), ns('25', undefined, -300000),
  ns('30', undefined, -900000), ns('40', undefined, -600000), ns('61', undefined, 200000)];

// What both books hold: a sale with its cost and a payroll in January 2025,
// the payment in February, rent on the card in March, and in January 2026 a
// sale, bank interest and a bank fee.
const BOTH: Array<[string, Move[]]> = [
  ['2025-01-01', [['12', 107000], ['40', -100000], ['22', -7000], ['50', 40000], ['13', -40000], ['61', 30000], ['62', 3000], ['10', -33000]]],
  ['2025-02-01', [['10', 107000], ['12', -107000]]],
  ['2025-03-01', [['65', 50000], ['21', -50000]]],
  ['2026-01-01', [['12', 200000], ['40', -200000], ['10', 1000], ['80', -1000], ['90', 500], ['10', -500]]],
];
// February 2026's rent: 600 in FleetSuite, 650 in NetSuite, and shop supplies FleetSuite alone has.
const FS_FEB: Move[] = [['65', 60000], ['10', -60000], [SHOP, 2500], ['10', -2500]];
const NS_FEB: Move[] = [['65', 65000], ['10', -65000]];

function books(opts: { fleetsuite?: ReportAmount[]; netsuite?: TbAmount[]; accounts?: ReportAccount[] } = {}): ReportData {
  const moves = (side: 'fs' | 'ns') => [
    ...BOTH.flatMap(([month, list]) => list.map(([a, c]) => (side === 'fs' ? fs(a, month, c) : ns(a, month, c)))),
    ...(side === 'fs' ? FS_FEB : NS_FEB).map(([a, c]) => (side === 'fs' ? fs(a, '2026-02-01', c) : ns(a, '2026-02-01', c))),
  ];
  return {
    company: 'BMG',
    accounts: opts.accounts ?? ACCOUNTS,
    opening: OPENING,
    netsuite: [...(moves('ns') as TbAmount[]), ...(opts.netsuite ?? [])],
    fleetsuite: [...(moves('fs') as ReportAmount[]), ...(opts.fleetsuite ?? [])],
  };
}

const shape = (lines: ReportLine[]) => lines.map((l) => [l.kind, l.depth, l.label, l.fleetsuite, l.netsuite]);
const amountOf = (lines: ReportLine[], label: string) => {
  const line = lines.find((l) => l.label === label);
  return line ? [line.fleetsuite, line.netsuite] : undefined;
};

describe('the profit and loss', () => {
  it("lays a month out as NetSuite's income statement, accounts under their parents", () => {
    const pl = report(books(), 'profit_and_loss', { to: '2025-01-01' });
    expect(shape(pl.lines)).toEqual([
      ['section', 0, 'Income', null, null],
      ['account', 1, 'Sales', 100000, 100000],
      ['total', 0, 'Total income', 100000, 100000],
      ['section', 0, 'Cost of sales', null, null],
      ['account', 1, 'Cost of Goods Sold', 40000, 40000],
      ['total', 0, 'Total cost of sales', 40000, 40000],
      ['total', 0, 'Gross profit', 60000, 60000],
      ['section', 0, 'Expense', null, null],
      ['heading', 1, 'Payroll', null, null],
      ['account', 2, 'Wages', 30000, 30000],
      ['account', 2, 'Payroll taxes', 3000, 3000],
      ['total', 1, 'Total Payroll', 33000, 33000],
      ['total', 0, 'Total expense', 33000, 33000],
      ['total', 0, 'Net ordinary income', 27000, 27000],
      ['total', 0, 'Net income', 27000, 27000],
    ]);
    expect(pl.differing).toBe(0);
    expect(pl.lines.filter((l) => l.grand).map((l) => l.label)).toEqual(['Gross profit', 'Net ordinary income', 'Net income']);
    expect(pl.lines.find((l) => l.label === 'Sales')).toMatchObject({ number: '4000', account: '40', inChart: true });
    expect(pl.totals).toBeUndefined();
  });

  it('adds up any range of months, across the end of a year too', () => {
    const quarter = report(books(), 'profit_and_loss', { from: '2025-01-01', to: '2025-03-01' }).lines;
    expect(amountOf(quarter, 'Total expense')).toEqual([83000, 83000]);
    expect(amountOf(quarter, 'Rent')).toEqual([50000, 50000]);
    // A loss reads as a negative.
    expect(amountOf(quarter, 'Net income')).toEqual([-23000, -23000]);
    // March alone is the rent.
    expect(shape(report(books(), 'profit_and_loss', { from: '2025-03-01', to: '2025-03-01' }).lines)).toEqual([
      ['total', 0, 'Gross profit', 0, 0],
      ['section', 0, 'Expense', null, null],
      ['account', 1, 'Rent', 50000, 50000],
      ['total', 0, 'Total expense', 50000, 50000],
      ['total', 0, 'Net ordinary income', -50000, -50000],
      ['total', 0, 'Net income', -50000, -50000],
    ]);
    // March 2025 through February 2026: both rents, January 2026's sale, interest and fee, and the shop supplies.
    const year = report(books(), 'profit_and_loss', { from: '2025-03-01', to: '2026-02-01' }).lines;
    expect(amountOf(year, 'Total income')).toEqual([200000, 200000]);
    expect(amountOf(year, 'Rent')).toEqual([110000, 115000]);
    expect(amountOf(year, 'Net income')).toEqual([88000, 85500]);
    // Without a start, or with one after the end, it's the end's month alone.
    expect(report(books(), 'profit_and_loss', { to: '2025-03-01' })).toEqual(report(books(), 'profit_and_loss', { from: '2025-03-01', to: '2025-03-01' }));
    expect(report(books(), 'profit_and_loss', { from: '2026-02-01', to: '2025-03-01' })).toEqual(report(books(), 'profit_and_loss', { to: '2025-03-01' }));
  });

  it('shows other income and expense with their net when there are any', () => {
    expect(shape(report(books(), 'profit_and_loss', { from: '2026-01-01', to: '2026-01-01' }).lines)).toEqual([
      ['section', 0, 'Income', null, null],
      ['account', 1, 'Sales', 200000, 200000],
      ['total', 0, 'Total income', 200000, 200000],
      ['total', 0, 'Gross profit', 200000, 200000],
      ['total', 0, 'Net ordinary income', 200000, 200000],
      ['section', 0, 'Other income', null, null],
      ['account', 1, 'Interest income', 1000, 1000],
      ['total', 0, 'Total other income', 1000, 1000],
      ['section', 0, 'Other expense', null, null],
      ['account', 1, 'Bank fees', 500, 500],
      ['total', 0, 'Total other expense', 500, 500],
      ['total', 0, 'Net other income', 500, 500],
      ['total', 0, 'Net income', 200500, 200500],
    ]);
  });

  it("counts the accounts that differ, FleetSuite's own among them", () => {
    const pl = report(books(), 'profit_and_loss', { to: '2026-02-01' });
    expect(shape(pl.lines.filter((l) => l.kind !== 'section'))).toEqual([
      ['total', 0, 'Gross profit', 0, 0],
      ['account', 1, 'Rent', 60000, 65000],
      ['account', 1, 'Shop supplies', 2500, 0],
      ['total', 0, 'Total expense', 62500, 65000],
      ['total', 0, 'Net ordinary income', -62500, -65000],
      ['total', 0, 'Net income', -62500, -65000],
    ]);
    expect(pl.differing).toBe(2);
    expect(pl.lines.find((l) => l.label === 'Shop supplies')).toMatchObject({ account: SHOP, number: '6900', inChart: true });
  });
});

describe('the balance sheet', () => {
  it("starts from NetSuite's balances, with earlier years' income in retained earnings and this year's as net income", () => {
    const bs = report(books(), 'balance_sheet', { to: '2025-03-01' });
    expect(shape(bs.lines)).toEqual([
      ['section', 0, 'Assets', null, null],
      ['section', 1, 'Current assets', null, null],
      ['section', 2, 'Bank', null, null],
      ['account', 3, 'Checking', 1074000, 1074000],
      ['total', 2, 'Total bank', 1074000, 1074000],
      ['section', 2, 'Other current assets', null, null],
      ['account', 3, 'Inventory', 60000, 60000],
      ['total', 2, 'Total other current assets', 60000, 60000],
      ['total', 1, 'Total current assets', 1134000, 1134000],
      ['section', 1, 'Fixed assets', null, null],
      ['account', 2, 'Trucks', 500000, 500000],
      ['total', 1, 'Total fixed assets', 500000, 500000],
      ['total', 0, 'Total assets', 1634000, 1634000],
      ['section', 0, 'Liabilities and equity', null, null],
      ['section', 1, 'Current liabilities', null, null],
      ['section', 2, 'Credit card', null, null],
      ['account', 3, 'Chase card', 50000, 50000],
      ['total', 2, 'Total credit card', 50000, 50000],
      ['section', 2, 'Other current liabilities', null, null],
      ['account', 3, 'Sales tax', 7000, 7000],
      ['total', 2, 'Total other current liabilities', 7000, 7000],
      ['total', 1, 'Total current liabilities', 57000, 57000],
      ['section', 1, 'Long term liabilities', null, null],
      ['account', 2, 'Loan', 300000, 300000],
      ['total', 1, 'Total long term liabilities', 300000, 300000],
      ['total', 1, 'Total liabilities', 357000, 357000],
      ['section', 1, 'Equity', null, null],
      ['account', 2, 'Owner capital', 900000, 900000],
      ['account', 2, 'Retained Earnings', 400000, 400000],
      ['account', 2, 'Net income', -23000, -23000],
      ['total', 1, 'Total equity', 1277000, 1277000],
      ['total', 0, 'Total liabilities and equity', 1634000, 1634000],
    ]);
    expect(bs.differing).toBe(0);
    // A start doesn't change a balance sheet: it's the end's.
    expect(report(books(), 'balance_sheet', { from: '2025-01-01', to: '2025-03-01' })).toEqual(bs);
    expect(bs.lines.find((l) => l.label === 'Net income')).toMatchObject({ derived: true });
    expect(bs.lines.filter((l) => l.grand).map((l) => l.label)).toEqual(['Total assets', 'Total liabilities and equity']);
  });

  it("moves last year's income into retained earnings in a new year", () => {
    const lines = report(books(), 'balance_sheet', { to: '2026-01-01' }).lines;
    expect(amountOf(lines, 'Retained Earnings')).toEqual([377000, 377000]);
    expect(amountOf(lines, 'Net income')).toEqual([200500, 200500]);
    expect(amountOf(lines, 'Receivables')).toEqual([200000, 200000]);
    expect(amountOf(lines, 'Total assets')).toEqual([1834500, 1834500]);
    expect(amountOf(lines, 'Total liabilities and equity')).toEqual([1834500, 1834500]);
  });

  it('counts the lines that differ, and still balances on each side', () => {
    const bs = report(books(), 'balance_sheet', { to: '2026-02-01' });
    expect(amountOf(bs.lines, 'Checking')).toEqual([1012000, 1009500]);
    expect(amountOf(bs.lines, 'Net income')).toEqual([138000, 135500]);
    expect(bs.differing).toBe(2);
    expect(amountOf(bs.lines, 'Total assets')).toEqual([1772000, 1769500]);
    expect(amountOf(bs.lines, 'Total liabilities and equity')).toEqual([1772000, 1769500]);
  });

  it('balances every month on both sides when both books do', () => {
    for (const month of ['2025-01-01', '2025-02-01', '2025-06-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-07-01']) {
      const lines = report(books(), 'balance_sheet', { to: month }).lines;
      expect(amountOf(lines, 'Total assets'), month).toEqual(amountOf(lines, 'Total liabilities and equity'));
    }
  });

  it('puts unbilled receivables and deferred expense with other current assets, and deferred revenue with other current liabilities', () => {
    const accounts = [...ACCOUNTS, account('a14', '14', '1400', 'Unbilled', 'unbilled_receivable'),
      account('a16', '16', '1450', 'Prepaid', 'deferred_expense'), account('a23', '23', '2300', 'Deferred revenue', 'deferred_revenue')];
    const moves: Move[] = [['14', 1000], ['16', 2000], ['23', -3000]];
    const lines = report(books({
      accounts, netsuite: moves.map(([a, c]) => ns(a, '2025-01-01', c)), fleetsuite: moves.map(([a, c]) => fs(a, '2025-01-01', c)),
    }), 'balance_sheet', { to: '2025-01-01' }).lines;
    const part = (label: string) => shape(lines.slice(lines.findIndex((l) => l.label === label), lines.findIndex((l) => l.label === `Total ${label.toLowerCase()}`) + 1));
    expect(part('Other current assets')).toEqual([
      ['section', 2, 'Other current assets', null, null],
      ['account', 3, 'Inventory', 60000, 60000],
      ['account', 3, 'Unbilled', 1000, 1000],
      ['account', 3, 'Prepaid', 2000, 2000],
      ['total', 2, 'Total other current assets', 63000, 63000],
    ]);
    expect(part('Other current liabilities')).toEqual([
      ['section', 2, 'Other current liabilities', null, null],
      ['account', 3, 'Sales tax', 7000, 7000],
      ['account', 3, 'Deferred revenue', 3000, 3000],
      ['total', 2, 'Total other current liabilities', 10000, 10000],
    ]);
    expect(amountOf(lines, 'Total assets')).toEqual(amountOf(lines, 'Total liabilities and equity'));
  });

  it('puts earlier income on a line of its own when no one account is retained earnings', () => {
    // Two accounts named for it: neither takes it.
    const two = [...ACCOUNTS, account('a38', '38', '3800', 'Retained earnings (old)', 'equity')];
    const lines = report(books({ accounts: two }), 'balance_sheet', { to: '2025-03-01' }).lines;
    const equity = lines.slice(lines.findIndex((l) => l.label === 'Equity'));
    expect(shape(equity.filter((l) => l.kind === 'account'))).toEqual([
      ['account', 2, 'Owner capital', 900000, 900000],
      ['account', 2, 'Retained earnings (net income of earlier years)', 400000, 400000],
      ['account', 2, 'Net income', -23000, -23000],
    ]);
    // One of the two limited to the other company: the other takes it.
    const other = two.map((a) => (a.id === 'a38' ? { ...a, company: '1084' } : a));
    expect(amountOf(report(books({ accounts: other }), 'balance_sheet', { to: '2025-03-01' }).lines, 'Retained Earnings')).toEqual([400000, 400000]);
  });

  it("lists a NetSuite account the chart doesn't have yet apart, debit positive", () => {
    const data = books({ netsuite: [ns('77', '2025-01-01', 5000), ns('10', '2025-01-01', -5000)] });
    const bs = report(data, 'balance_sheet', { to: '2025-01-01' });
    expect(shape(bs.lines.slice(-2))).toEqual([
      ['section', 0, 'Not in the chart of accounts yet', null, null],
      ['account', 1, 'NetSuite account 77', 0, 5000],
    ]);
    expect(bs.lines.at(-1)).toMatchObject({ account: '77', inChart: false });
    expect(bs.differing).toBe(2);
    // Nor can the profit and loss, which shows what moved on it apart too, out of net income.
    const pl = report(data, 'profit_and_loss', { to: '2025-01-01' });
    expect(shape(pl.lines.slice(-3))).toEqual([
      ['total', 0, 'Net income', 27000, 27000],
      ['section', 0, 'Not in the chart of accounts yet', null, null],
      ['account', 1, 'NetSuite account 77', 0, 5000],
    ]);
    expect(pl.differing).toBe(1);
    expect(report(data, 'profit_and_loss', { to: '2025-02-01' }).lines.some((l) => l.account === '77')).toBe(false);
  });

  it("adds what FleetSuite's journal holds from before 2025 to its side", () => {
    const data = books({ fleetsuite: [fs('10', '2024-12-01', 1000), fs('40', '2024-12-01', -1000)] });
    const bs = report(data, 'balance_sheet', { to: '2025-01-01' });
    expect(amountOf(bs.lines, 'Checking')).toEqual([1000000 - 33000 + 1000, 1000000 - 33000]);
    expect(amountOf(bs.lines, 'Retained Earnings')).toEqual([401000, 400000]);
    expect(bs.differing).toBe(2);
    expect(report(data, 'profit_and_loss', { from: '2025-01-01', to: '2025-12-01' }).differing).toBe(0);
  });
});

describe('the trial balance', () => {
  it("is laid out as the trial balance check's, debit positive", () => {
    const tb = report(books(), 'trial_balance', { to: '2026-02-01' });
    expect(tb.lines.map((l) => [l.number, l.label, l.fleetsuite, l.netsuite])).toEqual([
      ['1000', 'Checking', 1012000, 1009500],
      ['1200', 'Receivables', 200000, 200000],
      ['1300', 'Inventory', 60000, 60000],
      ['1500', 'Trucks', 500000, 500000],
      ['2100', 'Chase card', -50000, -50000],
      ['2200', 'Sales tax', -7000, -7000],
      ['2500', 'Loan', -300000, -300000],
      ['3000', 'Owner capital', -900000, -900000],
      ['3900', 'Retained Earnings', -377000, -377000],
      ['4000', 'Sales', -200000, -200000],
      ['6500', 'Rent', 60000, 65000],
      ['6900', 'Shop supplies', 2500, 0],
      ['8000', 'Interest income', -1000, -1000],
      ['9000', 'Bank fees', 500, 500],
    ]);
    expect(tb.differing).toBe(3);
    expect(tb.totals).toEqual({
      fleetsuite: { debit: 1835000, credit: 1835000 },
      netsuite: { debit: 1835000, credit: 1835000 },
    });
    // The journal always balances, but a side that didn't would show in its totals.
    expect(report(books({ fleetsuite: [fs('10', '2025-01-01', 1000)] }), 'trial_balance', { to: '2025-01-01' }).totals).toEqual({
      fleetsuite: { debit: 1708000, credit: 1707000 },
      netsuite: { debit: 1707000, credit: 1707000 },
    });
  });

  it("has NetSuite's side as the trial balance check has it", () => {
    const data = books();
    for (const month of ['2025-01-01', '2025-03-01', '2026-02-01']) {
      const check = trialBalance({ company: 'BMG', accounts: data.accounts, opening: data.opening, netsuite: data.netsuite, copied: data.netsuite }, month);
      const lines = report(data, 'trial_balance', { to: month }).lines.filter((l) => l.netsuite);
      expect(lines.map((l) => [l.account, l.netsuite]), month).toEqual(check.rows.map((r) => [r.netsuiteAccountId, r.netsuite]));
    }
  });

  it('puts earlier income on a line of its own, after the balance sheet accounts, when no one account is retained earnings', () => {
    const renamed = ACCOUNTS.map((a) => (a.id === 'a39' ? { ...a, name: 'Owner draws' } : a));
    const lines = report(books({ accounts: renamed }), 'trial_balance', { to: '2025-03-01' }).lines;
    expect(lines.map((l) => l.label).slice(6, 8)).toEqual(['Owner capital', 'Retained earnings (net income of earlier years)']);
    expect(lines[7]).toMatchObject({ fleetsuite: -400000, netsuite: -400000, derived: true });
    expect(lines[8].label).toBe('Sales');
  });

  it("names a NetSuite account the chart doesn't have yet", () => {
    const tb = report(books({ netsuite: [ns('77', '2025-01-01', 5000), ns('10', '2025-01-01', -5000)] }), 'trial_balance', { to: '2025-01-01' });
    expect(tb.lines.find((l) => l.account === '77')).toMatchObject({ label: 'NetSuite account 77', number: null, inChart: false, fleetsuite: 0, netsuite: 5000 });
  });
});

describe('accounts under their parents', () => {
  // Account 9, the bank, takes the other side of every entry.
  const tree = (accounts: ReportAccount[], moves: Move[]) => report({
    company: 'BMG', accounts: [...accounts, account('bank', '9', '1000', 'Bank', 'bank')], opening: [],
    netsuite: moves.map(([a, c]) => ns(a, '2025-01-01', c)), fleetsuite: moves.map(([a, c]) => fs(a, '2025-01-01', c)),
  }, 'profit_and_loss', { to: '2025-01-01' }).lines.filter((l) => l.kind !== 'section' && !l.grand);

  it("shows a parent's own amount on its line, then what's under it and the total", () => {
    const lines = tree(
      [account('p', '1', '6000', 'Payroll', 'expense'), account('c', '2', '6010', 'Wages', 'expense', { parent_id: 'p' }),
        account('g', '3', '6011', 'Overtime', 'expense', { parent_id: 'c' }), account('e', '4', '6020', 'Empty', 'expense', { parent_id: 'p' })],
      [['1', 100], ['3', 200], ['9', -300]],
    );
    expect(shape(lines)).toEqual([
      ['account', 1, 'Payroll', 100, 100],
      ['heading', 2, 'Wages', null, null],
      ['account', 3, 'Overtime', 200, 200],
      ['total', 2, 'Total Wages', 200, 200],
      ['total', 1, 'Total Payroll', 300, 300],
      ['total', 0, 'Total expense', 300, 300],
    ]);
  });

  it('shows an account under a parent of another kind at the top of its own section, and one whose parents loop', () => {
    const lines = tree(
      [account('i', '1', '4000', 'Sales', 'income'), account('x', '2', '6100', 'Odd', 'expense', { parent_id: 'i' }),
        account('l1', '3', '6200', 'Loop A', 'expense', { parent_id: 'l2' }), account('l2', '4', '6300', 'Loop B', 'expense', { parent_id: 'l1' })],
      [['2', 100], ['3', 10], ['4', 20], ['9', -130]],
    );
    expect(shape(lines)).toEqual([
      ['account', 1, 'Odd', 100, 100],
      ['account', 1, 'Loop A', 10, 10],
      ['account', 2, 'Loop B', 20, 20],
      ['total', 1, 'Total Loop A', 30, 30],
      ['total', 0, 'Total expense', 130, 130],
    ]);
  });

  it('orders accounts by number, then those without one by name', () => {
    const lines = tree(
      [account('a', '1', '6100', 'Zed', 'expense'), account('b', '2', '610', 'Yak', 'expense'), account('c', '3', null, 'Bee', 'expense'),
        account('d', '4', null, 'Ant', 'expense')],
      [['1', 1], ['2', 1], ['3', 1], ['4', 1], ['9', -4]],
    );
    expect(lines.map((l) => l.label)).toEqual(['Yak', 'Zed', 'Ant', 'Bee', 'Total expense']);
  });
});

describe('the months', () => {
  it("marks each month by whether its report alone matches, as report() lays it out", () => {
    const differing = (kind: Parameters<typeof reportMonths>[1]) =>
      reportMonths(books(), kind, '2026-03-01').filter((m) => !m.matches).map((m) => [m.month, m.differing]);
    expect(reportMonths(books(), 'profit_and_loss', '2026-03-01')).toHaveLength(15);
    // A profit and loss by the month's own activity; a balance sheet or trial balance by its end.
    expect(differing('profit_and_loss')).toEqual([['2026-02-01', 2]]);
    expect(differing('balance_sheet')).toEqual([['2026-02-01', 2], ['2026-03-01', 2]]);
    expect(differing('trial_balance')).toEqual([['2026-02-01', 3], ['2026-03-01', 3]]);
    expect(reportMonths(books(), 'balance_sheet', '2026-03-01')[0]).toEqual({ month: '2025-01-01', matches: true, differing: 0 });
  });

  it('runs to the latest month either side has, but never before the floor', () => {
    expect(lastReportMonth(books(), '2026-01-01')).toBe('2026-02-01');
    expect(lastReportMonth(books(), '2026-10-01')).toBe('2026-10-01');
    expect(lastReportMonth(books({ fleetsuite: [fs('10', '2026-12-01', 100), fs('40', '2026-12-01', -100)] }), '2026-10-01')).toBe('2026-12-01');
  });
});

describe('the months a line differs in', () => {
  // On top of February 2026's: 5.00 of owner capital into the bank FleetSuite dated December 2024, 10.00 more rent in FleetSuite in
  // March 2025, paid from the bank, and a 3.00 bank fee only NetSuite has in January 2026.
  const data = () => books({
    fleetsuite: [fs('10', '2024-12-01', 500), fs('30', '2024-12-01', -500), fs('65', '2025-03-01', 1000), fs('10', '2025-03-01', -1000)],
    netsuite: [ns('90', '2026-01-01', 300), ns('10', '2026-01-01', -300)],
  });
  const monthsOf = (lines: ReportLine[], label: string) => lines.find((l) => l.label === label)?.months;

  it('gives each account line that differs the months whose own entries make it differ, as the line shows amounts', () => {
    const bs = report(data(), 'balance_sheet', { to: '2026-02-01' }).lines;
    expect(monthsOf(bs, 'Checking')).toEqual([
      { month: '2024-12-01', difference: 500 },
      { month: '2025-03-01', difference: -1000 },
      { month: '2026-01-01', difference: 300 },
      { month: '2026-02-01', difference: 2500 },
    ]);
    expect(monthsOf(bs, 'Owner capital')).toEqual([{ month: '2024-12-01', difference: 500 }]);
    // An earlier year's net income in retained earnings, this year's in net income.
    expect(monthsOf(bs, 'Retained Earnings')).toEqual([{ month: '2025-03-01', difference: -1000 }]);
    expect(monthsOf(bs, 'Net income')).toEqual([{ month: '2026-01-01', difference: 300 }, { month: '2026-02-01', difference: 2500 }]);
    // Nothing on a line that matches, or on a total.
    expect(bs.find((l) => l.label === 'Receivables')).not.toHaveProperty('months');
    expect(bs.filter((l) => l.kind !== 'account' && 'months' in l)).toEqual([]);

    // The profit and loss's, from its own months only.
    const pl = report(data(), 'profit_and_loss', { from: '2025-01-01', to: '2026-02-01' }).lines;
    expect(monthsOf(pl, 'Rent')).toEqual([{ month: '2025-03-01', difference: 1000 }, { month: '2026-02-01', difference: -5000 }]);
    expect(monthsOf(pl, 'Bank fees')).toEqual([{ month: '2026-01-01', difference: -300 }]);
    expect(monthsOf(report(data(), 'profit_and_loss', { from: '2026-02-01', to: '2026-02-01' }).lines, 'Rent'))
      .toEqual([{ month: '2026-02-01', difference: -5000 }]);

    // The trial balance's, debit positive, income and expenses for the year to date.
    const tb = report(data(), 'trial_balance', { to: '2026-02-01' }).lines;
    expect(monthsOf(tb, 'Rent')).toEqual([{ month: '2026-02-01', difference: -5000 }]);
    expect(monthsOf(tb, 'Retained Earnings')).toEqual([{ month: '2025-03-01', difference: 1000 }]);
    expect(monthsOf(tb, 'Owner capital')).toEqual([{ month: '2024-12-01', difference: -500 }]);
  });

  it('adds up to each line\'s difference, on every report, with a month of nothing left out', () => {
    const cases: Array<[Parameters<typeof report>[1], Parameters<typeof report>[2]]> = [
      ['profit_and_loss', { from: '2025-01-01', to: '2026-02-01' }], ['profit_and_loss', { to: '2026-01-01' }],
      ['balance_sheet', { to: '2025-12-01' }], ['balance_sheet', { to: '2026-02-01' }],
      ['trial_balance', { to: '2025-12-01' }], ['trial_balance', { to: '2026-02-01' }],
    ];
    for (const [kind, range] of cases) {
      const lines = report(data(), kind, range).lines;
      const differing = lines.filter((l) => l.kind === 'account' && l.fleetsuite !== l.netsuite);
      expect(differing.length, `${kind} ${range.to}`).toBeGreaterThan(0);
      for (const l of differing) {
        expect(l.months!.reduce((sum, m) => sum + m.difference, 0), `${kind} ${range.to} ${l.label}`).toBe(l.fleetsuite! - l.netsuite!);
        expect(l.months!.every((m) => m.difference !== 0), `${kind} ${range.to} ${l.label}`).toBe(true);
      }
    }
    // A report that matches has none.
    expect(report(books(), 'balance_sheet', { to: '2025-12-01' }).lines.filter((l) => 'months' in l)).toEqual([]);
  });

  it('keeps each line\'s months its own: a month only NetSuite has, two accounts of one name, two lines that are no account', () => {
    // A second Rent, and no Retained Earnings account, so the balance sheet shows earlier years' net income on a line of its own.
    const accounts = [...ACCOUNTS.filter((a) => a.id !== 'a39'), account('a66', '66', '6600', 'Rent', 'expense')];
    // 2.00 of the second Rent, paid from the bank in June 2025, a month only NetSuite has.
    const data = books({ accounts, netsuite: [ns('66', '2025-06-01', 200), ns('10', '2025-06-01', -200)] });

    const pl = report(data, 'profit_and_loss', { from: '2025-01-01', to: '2026-02-01' }).lines;
    expect(pl.find((l) => l.account === '65')?.months).toEqual([{ month: '2026-02-01', difference: -5000 }]);
    expect(pl.find((l) => l.account === '66')?.months).toEqual([{ month: '2025-06-01', difference: -200 }]);

    const bs = report(data, 'balance_sheet', { to: '2026-02-01' }).lines;
    expect(monthsOf(bs, 'Retained earnings (net income of earlier years)')).toEqual([{ month: '2025-06-01', difference: 200 }]);
    expect(monthsOf(bs, 'Net income')).toEqual([{ month: '2026-02-01', difference: 2500 }]);
  });
});
