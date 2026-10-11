import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { START, lastMonth, monthStatuses, trialBalance, type TbAccount, type TbAmount, type TbData } from './trial-balance';

const ACCOUNTS: TbAccount[] = [
  { netsuite_account_id: '10', number: '1000', name: 'Cash', account_type: 'bank', statement: 'balance_sheet' },
  { netsuite_account_id: '30', number: '3900', name: 'Retained Earnings', account_type: 'equity', statement: 'balance_sheet' },
  { netsuite_account_id: '40', number: '4000', name: 'Sales', account_type: 'income', statement: 'income_statement' },
  { netsuite_account_id: '50', number: '6000', name: 'Expenses', account_type: 'expense', statement: 'income_statement' },
];

const amount = (account: string, debit: string, credit: string, month?: string): TbAmount =>
  ({ netsuite_account_id: account, debit, credit, ...(month ? { month } : {}) });

// Made-up books. Before 2025: 1,000 cash, 600 of equity, and 400 of net
// income (500 of sales less 100 of expenses).
const OPENING = [amount('10', '1000.00', '0.00'), amount('30', '0.00', '600.00'), amount('40', '0.00', '500.00'), amount('50', '100.00', '0.00')];
const MOVES = [
  amount('10', '200.00', '0.00', '2025-01-01'), amount('40', '0.00', '200.00', '2025-01-01'),
  amount('50', '50.00', '0.00', '2025-06-01'), amount('10', '0.00', '50.00', '2025-06-01'),
  amount('10', '300.00', '0.00', '2026-02-01'), amount('40', '0.00', '300.00', '2026-02-01'),
];

const books = (copied = MOVES, accounts = ACCOUNTS, company = 'BMG'): TbData =>
  ({ company, accounts, opening: OPENING, netsuite: MOVES, copied });

const values = (data: TbData, month: string) =>
  trialBalance(data, month).rows.map((r) => [r.number ?? r.name, r.copied, r.netsuite]);

describe('trialBalance', () => {
  it('starts from NetSuite\'s balances, with earlier income in retained earnings', () => {
    const tb = trialBalance(books(), START);
    expect(tb.rows.map((r) => [r.number, r.copied, r.netsuite])).toEqual([['1000', 100000, 100000], ['3900', -100000, -100000]]);
    expect(tb.totals).toEqual({ copied: { debit: 100000, credit: 100000 }, netsuite: { debit: 100000, credit: 100000 } });
  });

  it('shows balance sheet accounts at month end and income for the year to date', () => {
    expect(values(books(), '2025-06-01')).toEqual([
      ['1000', 115000, 115000],
      ['3900', -100000, -100000],
      ['4000', -20000, -20000],
      ['6000', 5000, 5000],
    ]);
    // A new year: 2025's income moves into retained earnings.
    expect(values(books(), '2026-02-01')).toEqual([
      ['1000', 145000, 145000],
      ['3900', -115000, -115000],
      ['4000', -30000, -30000],
    ]);
    const tb = trialBalance(books(), '2026-02-01');
    expect(tb.totals.copied).toEqual({ debit: 145000, credit: 145000 });
    expect(tb.rows.every((r) => r.inChart)).toBe(true);
    expect(tb.rows.map((r) => r.statement)).toEqual(['balance_sheet', 'balance_sheet', 'income_statement']);
  });

  it('puts earlier income on a line of its own when no one account is retained earnings', () => {
    const renamed = ACCOUNTS.map((a) => (a.netsuite_account_id === '30' ? { ...a, name: 'Owner capital' } : a));
    const twice = [...ACCOUNTS, { netsuite_account_id: '31', number: '3950', name: 'Retained earnings - old', account_type: 'equity', statement: 'balance_sheet' }];
    for (const accounts of [renamed, twice]) {
      const rows = trialBalance(books(MOVES, accounts), '2025-06-01').rows;
      expect(rows.map((r) => [r.number ?? r.name, r.copied])).toEqual([
        ['1000', 115000],
        ['3900', -60000],
        ['Retained earnings (net income of earlier years)', -40000],
        ['4000', -20000],
        ['6000', 5000],
      ]);
      expect(rows[2]).toMatchObject({ retained: true, netsuiteAccountId: null, statement: 'balance_sheet' });
    }
  });

  it('uses the retained earnings account open to the company', () => {
    const accounts = [...ACCOUNTS, { netsuite_account_id: '31', number: '3950', name: '1084 Retained Earnings', account_type: 'equity', statement: 'balance_sheet', company: '1084' }];
    expect(values(books(MOVES, accounts, 'BMG'), '2025-06-01')[1]).toEqual(['3900', -100000, -100000]);
    expect(values(books(MOVES, accounts, '1084'), '2025-06-01')).toContainEqual(['Retained earnings (net income of earlier years)', -40000, -40000]);
  });

  it('shows an account the chart doesn\'t have yet, as a balance sheet account, after the numbered ones', () => {
    const copied = [...MOVES, amount('99', '25.00', '0.00', '2025-03-01'), amount('10', '0.00', '25.00', '2025-03-01')];
    const rows = trialBalance(books(copied), '2025-03-01').rows;
    expect(rows.find((r) => r.netsuiteAccountId === '99')).toEqual({
      netsuiteAccountId: '99', number: null, name: 'NetSuite account 99', statement: 'balance_sheet', inChart: false, copied: 2500, netsuite: 0,
    });
    expect(rows.map((r) => r.netsuiteAccountId)).toEqual(['10', '30', '99', '40']);
  });
});

describe('monthStatuses', () => {
  it('matches every month when the copy holds what NetSuite does', () => {
    const months = monthStatuses(books(), '2026-02-01');
    expect(months).toHaveLength(14);
    expect(months.every((m) => m.matches && m.differing === 0)).toBe(true);
  });

  it('counts the lines that differ from the month a difference starts', () => {
    const missing = MOVES.filter((m) => m.month !== '2025-06-01');
    const months = Object.fromEntries(monthStatuses(books(missing), '2026-02-01').map((m) => [m.month, m.differing]));
    expect(months['2025-05-01']).toBe(0);
    expect(months['2025-06-01']).toBe(2); // cash and expenses
    expect(months['2026-01-01']).toBe(2); // cash and retained earnings
  });

  it('flags a month whose balances agree but whose trial balance doesn\'t', () => {
    // The copy has June's expense in January 2026: by year end the cash
    // agrees again, but 2026's expenses and retained earnings don't.
    const moved = MOVES.map((m) => (m.month === '2025-06-01' ? { ...m, month: '2026-01-01' } : m));
    const months = Object.fromEntries(monthStatuses(books(moved), '2026-02-01').map((m) => [m.month, m.differing]));
    expect(months['2025-06-01']).toBe(2);
    expect(months['2026-01-01']).toBe(2);
    expect(values(books(moved), '2026-01-01').filter(([, c, n]) => c !== n).map(([label]) => label)).toEqual(['3900', '6000']);
  });
});

describe('lastMonth', () => {
  it('is the latest month either side has, never before the floor', () => {
    expect(lastMonth(books(), '2025-03-01')).toBe('2026-02-01');
    expect(lastMonth(books(), '2026-10-01')).toBe('2026-10-01');
  });
});
