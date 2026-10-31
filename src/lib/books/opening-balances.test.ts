import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { addDays, lastDay, PLANNED_LIVE_FROM, rehearse, workOutOpeningEntry, type OpeningAccount, type OpeningData } from './opening-balances';
import type { ReportAmount } from './reports';
import type { TbAmount } from './trial-balance';

const account = (id: string, ns: string | null, number: string, name: string, type: string, more: Partial<OpeningAccount> = {}): OpeningAccount => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: type === 'income' || type === 'expense' ? 'income_statement' : 'balance_sheet', is_summary: false, company: null, ...more,
});

const ACCOUNTS: OpeningAccount[] = [
  account('a1', '10', '1000', 'Cash', 'bank'),
  account('a2', '12', '1200', 'Accounts Receivable', 'accounts_receivable'),
  account('a3', '30', '3900', 'Retained Earnings', 'equity'),
  account('a4', '35', '3950', 'Owner distributions', 'equity'),
  account('a5', '40', '4000', 'Sales', 'income'),
  account('a6', '50', '6000', 'Expenses', 'expense'),
];

const amount = (acct: string, debit: string, credit: string, month?: string): TbAmount =>
  ({ netsuite_account_id: acct, debit, credit, ...(month ? { month } : {}) });

// Made-up books. Before 2025: 1,000 cash, 600 of retained earnings, and 400
// of net income (500 of sales less 100 of expenses).
const OPENING = [amount('10', '1000.00', '0.00'), amount('30', '0.00', '600.00'), amount('40', '0.00', '500.00'), amount('50', '100.00', '0.00')];
const SALE = [amount('10', '200.00', '0.00', '2025-01-01'), amount('40', '0.00', '200.00', '2025-01-01')];
const LATER = [
  amount('50', '50.00', '0.00', '2025-06-01'), amount('10', '0.00', '50.00', '2025-06-01'),
  amount('35', '100.00', '0.00', '2025-09-01'), amount('10', '0.00', '100.00', '2025-09-01'),
  amount('12', '300.00', '0.00', '2025-12-01'), amount('40', '0.00', '300.00', '2025-12-01'),
  amount('10', '300.00', '0.00', '2026-02-01'), amount('12', '0.00', '300.00', '2026-02-01'),
];
const MOVES = [...SALE, ...LATER];

const books = (more: Partial<OpeningData> = {}): OpeningData =>
  ({ company: 'BMG', accounts: ACCOUNTS, opening: OPENING, netsuite: MOVES, copied: MOVES, ...more });

/** FleetSuite's journal as gl_books_totals gives it. */
const journal = (moves: TbAmount[]): ReportAmount[] =>
  moves.map((m) => ({ account: m.netsuite_account_id, month: m.month!, debit: m.debit, credit: m.credit }));
/** FleetSuite's own journal: January's sale posted at 180.00 where NetSuite has 200.00, the rest the same. */
const JOURNAL = journal([amount('10', '180.00', '0.00', '2025-01-01'), amount('40', '0.00', '180.00', '2025-01-01'), ...LATER]);

const entryOf = (month: string, more: Partial<OpeningData> = {}, fleetsuite = JOURNAL, today = '2026-10-31') =>
  workOutOpeningEntry(books(more), fleetsuite, month, today);
const lines = (month: string, more: Partial<OpeningData> = {}, fleetsuite = JOURNAL) =>
  entryOf(month, more, fleetsuite).lines.map((l) => [l.number ?? l.name, l.cents]);

describe('lastDay and addDays', () => {
  it('finds the last day of a month, leap years too', () => {
    expect(lastDay('2026-12-01')).toBe('2026-12-31');
    expect(lastDay('2026-02-01')).toBe('2026-02-28');
    expect(lastDay('2028-02-01')).toBe('2028-02-29');
    expect(lastDay('2026-09-01')).toBe('2026-09-30');
  });

  it('moves a day across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays(PLANNED_LIVE_FROM, -1)).toBe('2026-12-31');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-31', 0)).toBe('2026-10-31');
  });
});

describe('workOutOpeningEntry', () => {
  it("brings each account FleetSuite has differently to NetSuite's balance on the day", () => {
    const entry = entryOf('2025-12-01', {}, JOURNAL, '2026-01-15');
    expect(entry).toMatchObject({ company: 'BMG', month: '2025-12-01', date: '2025-12-31', liveFrom: '2026-01-01', debit: 2000, credit: 2000, problems: [] });
    expect(entry.lines).toEqual([
      { netsuiteAccountId: '10', accountId: 'a1', number: '1000', name: 'Cash', fleetsuite: 103000, netsuite: 105000, cents: 2000 },
      { netsuiteAccountId: '40', accountId: 'a5', number: '4000', name: 'Sales', fleetsuite: -48000, netsuite: -50000, cents: -2000 },
    ]);
  });

  it("puts an earlier year's difference on retained earnings", () => {
    expect(lines('2026-01-01')).toEqual([['1000', 2000], ['3900', -2000]]);
    expect(entryOf('2026-01-01').lines[1]).toMatchObject({ fleetsuite: -143000, netsuite: -145000 });
  });

  it('posts nothing when the books already match', () => {
    const entry = entryOf('2025-12-01', {}, journal(MOVES));
    expect(entry).toMatchObject({ lines: [], debit: 0, credit: 0, problems: [] });
    // Before the books differ, the same.
    expect(entryOf('2024-12-01').lines).toEqual([]);
  });

  it("works on NetSuite's own totals, not the copy", () => {
    // The copy is missing December's invoice here, which is a problem of its own, but the entry is the same.
    expect(lines('2025-12-01', { copied: [...SALE, ...LATER.slice(0, 4)] })).toEqual(lines('2025-12-01'));
  });

  it("names an account only FleetSuite has by FleetSuite's id", () => {
    const accounts = [...ACCOUNTS, account('a9', null, '6900', 'Shop supplies', 'expense')];
    // FleetSuite put December's 25.00 of supplies on its own account, where NetSuite has it on Expenses.
    const netsuite = [...MOVES, amount('50', '25.00', '0.00', '2025-12-01'), amount('10', '0.00', '25.00', '2025-12-01')];
    const fleetsuite = [...JOURNAL, { account: 'fs:a9', month: '2025-12-01', debit: '25.00', credit: '0.00' }, { account: '10', month: '2025-12-01', debit: '0.00', credit: '25.00' }];
    const entry = workOutOpeningEntry(books({ accounts, netsuite, copied: netsuite }), fleetsuite, '2025-12-01', '2026-10-31');
    expect(entry.lines.map((l) => [l.netsuiteAccountId, l.accountId, l.number, l.cents])).toEqual([
      ['10', 'a1', '1000', 2000], ['40', 'a5', '4000', -2000], ['50', 'a6', '6000', 2500], ['fs:a9', 'a9', '6900', -2500],
    ]);
    expect(entry.problems).toEqual([]);
  });

  it("says so while the month isn't over", () => {
    expect(entryOf('2025-12-01', {}, JOURNAL, '2025-12-31').problems).toEqual(["December 2025 isn't over yet, so its balances are still changing."]);
    expect(entryOf('2025-12-01', {}, JOURNAL, '2025-12-05').problems).toHaveLength(1);
    expect(entryOf('2025-12-01', {}, JOURNAL, '2026-01-01').problems).toEqual([]);
  });

  it("says so when nothing has been copied from NetSuite's ledger", () => {
    const entry = entryOf('2025-12-01', { opening: [], netsuite: [], copied: [] }, []);
    expect(entry).toMatchObject({ lines: [], debit: 0, credit: 0 });
    expect(entry.problems).toEqual(["Nothing has been copied from NetSuite's ledger yet: Trial balance vs NetSuite → Copy now."]);
    // The starting entry alone, or the months alone, is a copy.
    expect(entryOf('2025-01-01', { netsuite: [], copied: [] }, []).problems).toEqual([]);
    expect(entryOf('2025-12-01', { opening: [] }).problems).not.toContainEqual(expect.stringMatching(/^Nothing/));
  });

  it("says so when the copy differs from NetSuite's own totals on the day", () => {
    const noReceivable = MOVES.filter((m) => !(m.netsuite_account_id === '12' && m.month === '2025-12-01'));
    expect(entryOf('2025-12-01', { copied: noReceivable }).problems).toEqual([
      "On December 31, 2025 the copy of NetSuite's ledger differs from NetSuite's own totals on 1 account: copy it again "
        + '(Trial balance vs NetSuite → Copy now), or find what differs there.',
    ]);
    expect(entryOf('2025-12-01', { copied: LATER }).problems[0]).toContain('on 2 accounts: copy it again');
    // A difference after the day doesn't matter to it.
    expect(entryOf('2025-12-01', { copied: MOVES.filter((m) => m.month !== '2026-02-01') }).problems).toEqual([]);
  });

  it("takes earlier years' net income to the company's own retained earnings account", () => {
    const accounts = [
      ...ACCOUNTS.map((a) => (a.id === 'a3' ? { ...a, company: 'BMG' } : a)),
      account('a8', '31', '3910', 'Retained Earnings', 'equity', { company: '1084' }),
    ];
    expect(lines('2026-01-01', { accounts })).toEqual([['1000', 2000], ['3900', -2000]]);
    expect(entryOf('2026-01-01', { accounts }).problems).toEqual([]);
    expect(lines('2026-01-01', { accounts, company: '1084' })).toEqual([['1000', 2000], ['3910', -2000]]);
  });

  it("says so when earlier years' net income differs and no one account takes it", () => {
    const renamed = ACCOUNTS.map((a) => (a.id === 'a3' ? { ...a, name: 'Owner capital' } : a));
    const entry = entryOf('2026-01-01', { accounts: renamed });
    expect(entry.lines.map((l) => [l.number, l.cents])).toEqual([['1000', 2000]]);
    expect(entry.problems).toEqual([
      "Earlier years' net income differs from NetSuite's by $20.00, but the chart needs exactly one equity account named "
        + 'Retained Earnings that BMG can use to take it.',
    ]);
    // Within the year it's on the income account, so nothing stops it.
    expect(entryOf('2025-12-01', { accounts: renamed }).problems).toEqual([]);
  });

  it("says so for an account the chart doesn't have yet", () => {
    const netsuite = [...MOVES, amount('99', '75.00', '0.00', '2025-12-01'), amount('10', '0.00', '75.00', '2025-12-01')];
    const entry = entryOf('2025-12-01', { netsuite, copied: netsuite });
    expect(entry.lines).toContainEqual({ netsuiteAccountId: '99', accountId: null, number: null, name: 'NetSuite account 99', fleetsuite: 0, netsuite: 7500, cents: 7500 });
    expect(entry.problems).toEqual(["NetSuite account 99 isn't in FleetSuite's chart yet, but the entry posts a debit of $75.00 to it: Chart of accounts → Sync now."]);
    expect(entry).toMatchObject({ debit: 7500, credit: 7500 });
  });

  it('says so for a heading', () => {
    const accounts = ACCOUNTS.map((a) => (a.id === 'a3' ? { ...a, is_summary: true } : a));
    expect(entryOf('2026-01-01', { accounts }).problems).toEqual([
      "3900 Retained Earnings is a heading in NetSuite's chart, which takes no postings, but the entry posts a credit of $20.00 to it.",
    ]);
  });

  it("says so for an account that's only for the other company", () => {
    const only = (company: string | null) => ACCOUNTS.map((a) => (a.id === 'a1' ? { ...a, company } : a));
    expect(entryOf('2025-12-01', { accounts: only('1084') }).problems).toEqual([
      "1000 Cash is only for 1084, but BMG's entry posts a debit of $20.00 to it.",
    ]);
    expect(entryOf('2025-12-01', { accounts: only('BMG') }).problems).toEqual([]);
    expect(entryOf('2025-12-01', { accounts: only(null) }).problems).toEqual([]);
  });

  it("says so when NetSuite's balances don't balance", () => {
    const netsuite = [...MOVES, amount('10', '5.00', '0.00', '2025-11-01')];
    const entry = entryOf('2025-12-01', { netsuite, copied: netsuite });
    expect(entry).toMatchObject({ debit: 2500, credit: 2000 });
    expect(entry.problems).toEqual(["NetSuite's balances on December 31, 2025 don't balance: debits and credits differ by $5.00."]);
    const short = [...MOVES, amount('40', '0.00', '7.00', '2025-11-01')];
    expect(entryOf('2025-12-01', { netsuite: short, copied: short }).problems).toEqual([
      "NetSuite's balances on December 31, 2025 don't balance: debits and credits differ by $7.00.",
    ]);
  });
});

describe('rehearse', () => {
  const rows = (month: string, fleetsuite = JOURNAL, through = '2026-02-01', data = books()) =>
    rehearse(data, fleetsuite, month, through)!.rows.map((r) => [r.number ?? r.name, r.fleetsuite, r.netsuite]);

  it("opens FleetSuite's books at NetSuite's numbers, then adds what FleetSuite has posted since", () => {
    // January's sale differs, but before the day, so the entry takes it up.
    const r = rehearse(books(), JOURNAL, '2025-12-01', '2026-02-01')!;
    expect(r).toMatchObject({ through: '2026-02-01', date: '2026-02-28', differing: 0 });
    expect(r.rows.map((x) => [x.number, x.fleetsuite, x.netsuite])).toEqual([['1000', 135000, 135000], ['3900', -145000, -145000], ['3950', 10000, 10000]]);
    expect(r.rows.every((x) => x.inChart && x.statement === 'balance_sheet')).toBe(true);
    expect(r.totals).toEqual({ fleetsuite: { debit: 145000, credit: 145000 }, netsuite: { debit: 145000, credit: 145000 } });
  });

  it("lays out the year as the books would, the year's income and expenses whole", () => {
    expect(rows('2025-06-01', JOURNAL, '2025-12-01')).toEqual([
      ['1000', 105000, 105000], ['1200', 30000, 30000], ['3900', -100000, -100000], ['3950', 10000, 10000], ['4000', -50000, -50000], ['6000', 5000, 5000],
    ]);
  });

  it('shows where FleetSuite has posted something differently since', () => {
    // February's payment posted at 350.00 where NetSuite has 300.00.
    const over = JOURNAL.map((m) => (m.month === '2026-02-01' ? { ...m, debit: m.debit === '0.00' ? '0.00' : '350.00', credit: m.credit === '0.00' ? '0.00' : '350.00' } : m));
    const r = rehearse(books(), over, '2025-12-01', '2026-02-01')!;
    expect(r.rows.map((x) => [x.number, x.fleetsuite, x.netsuite])).toEqual([
      ['1000', 140000, 135000], ['1200', -5000, 0], ['3900', -145000, -145000], ['3950', 10000, 10000],
    ]);
    expect(r.differing).toBe(2);
    expect(r.totals).toEqual({ fleetsuite: { debit: 150000, credit: 150000 }, netsuite: { debit: 145000, credit: 145000 } });
  });

  it("takes the entry's month from NetSuite and the months after it from FleetSuite", () => {
    // FleetSuite never posted December's invoice.
    const noInvoice = JOURNAL.filter((m) => m.month !== '2025-12-01');
    expect(rows('2025-12-01', noInvoice)).toEqual(rows('2025-12-01'));
    expect(rows('2025-11-01', noInvoice)).toEqual([['1000', 135000, 135000], ['1200', -30000, 0], ['3900', -115000, -145000], ['3950', 10000, 10000]]);
  });

  it("opens at NetSuite's own totals, not the copy", () => {
    // The copy is missing December's invoice here, which the entry says is a problem of its own.
    expect(rows('2025-12-01', JOURNAL, '2026-02-01', books({ copied: [...SALE, ...LATER.slice(0, 4)] }))).toEqual(rows('2025-12-01'));
  });

  it('counts only through the month it compares', () => {
    const march = [amount('10', '100.00', '0.00', '2026-03-01'), amount('40', '0.00', '100.00', '2026-03-01')];
    const data = books({ netsuite: [...MOVES, ...march], copied: [...MOVES, ...march] });
    const fleetsuite = [...JOURNAL, ...journal(march)];
    expect(rows('2025-12-01', fleetsuite, '2026-02-01', data)).toEqual(rows('2025-12-01'));
    expect(rows('2025-12-01', fleetsuite, '2026-03-01', data)).toEqual([
      ['1000', 145000, 145000], ['3900', -145000, -145000], ['3950', 10000, 10000], ['4000', -10000, -10000],
    ]);
  });

  it("names an account only FleetSuite has by FleetSuite's id", () => {
    const accounts = [...ACCOUNTS, account('a9', null, '6900', 'Shop supplies', 'expense')];
    const supplies = [...JOURNAL, { account: 'fs:a9', month: '2026-02-01', debit: '25.00', credit: '0.00' }, { account: '10', month: '2026-02-01', debit: '0.00', credit: '25.00' }];
    const r = rehearse(books({ accounts }), supplies, '2025-12-01', '2026-02-01')!;
    expect(r.rows.map((x) => [x.netsuiteAccountId, x.number, x.fleetsuite, x.netsuite, x.statement, x.inChart])).toEqual([
      ['10', '1000', 132500, 135000, 'balance_sheet', true],
      ['30', '3900', -145000, -145000, 'balance_sheet', true],
      ['35', '3950', 10000, 10000, 'balance_sheet', true],
      ['fs:a9', '6900', 2500, 0, 'income_statement', true],
    ]);
    expect(r.differing).toBe(2);
  });

  it('waits for a month to end after the entry', () => {
    expect(rehearse(books(), JOURNAL, '2025-12-01', '2025-12-01')).toBeNull();
    expect(rehearse(books(), JOURNAL, '2025-12-01', '2025-11-01')).toBeNull();
    expect(rehearse(books(), JOURNAL, '2025-12-01', '2026-01-01')).toMatchObject({ through: '2026-01-01', date: '2026-01-31', differing: 0 });
  });
});
