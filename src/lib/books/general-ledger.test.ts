import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import type { SupabaseClient } from '@supabase/supabase-js';
import { generalLedger, ledgerAccounts } from './general-ledger';
import type { LoadedReports } from './report-data';
import type { AccountDocumentData, AccountDocumentsData } from './report-detail';
import type { ReportAccount, ReportAmount, ReportData } from './reports';
import type { TbAmount } from './trial-balance';
import { readLedger } from './year-end-data';

const INCOME_STATEMENT = new Set(['income', 'expense']);
const account = (id: string, ns: string | null, number: string, name: string, type: string): ReportAccount => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: INCOME_STATEMENT.has(type) ? 'income_statement' : 'balance_sheet', parent_id: null,
});

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const ns = (acct: string, month: string | undefined, cents: number): TbAmount => ({ netsuite_account_id: acct, ...sides(cents), ...(month ? { month } : {}) });
const fs = (acct: string, month: string, cents: number): ReportAmount => ({ account: acct, month, ...sides(cents) });
/** Both books, the same. */
const both = (acct: string, month: string, cents: number) => ({ netsuite: ns(acct, month, cents), fleetsuite: fs(acct, month, cents) });

/**
 * Made-up books for 2027. Before 2025: 39.00 of petty cash, 1,000.00 in the
 * bank, 5,000.00 of trucks, 1,000.00 owed on a NetSuite account the chart
 * doesn't have, and the rest retained earnings. In 2026 a 3,000.00 sale and
 * 200.00 of an old expense, so 2,800.00 comes into retained earnings at
 * January 2027, and a prepaid that came and went. In 2027 a 10,000.00 cash
 * sale through Undeposited Funds into the bank in March, April's rent
 * (2,000.00 in NetSuite's books, 2,100.00 in FleetSuite's) and 50.00 of shop
 * supplies FleetSuite alone has, in May.
 */
const ACCOUNTS: ReportAccount[] = [
  account('a10', '10', '1010', 'First Bank checking', 'bank'),
  account('a09', '9', '900', 'Petty cash', 'bank'),
  account('a12', '12', '1200', 'Undeposited Funds', 'other_current_asset'),
  account('a13', '13', '1300', 'Prepaid', 'other_current_asset'),
  account('a15', '15', '1500', 'Trucks', 'fixed_asset'),
  account('a39', '39', '3900', 'Retained Earnings', 'equity'),
  account('a40', '40', '4000', 'Sales', 'income'),
  account('a60', '60', '6000', 'Rent', 'expense'),
  account('a61', '61', '6100', 'Old expense', 'expense'),
  account('afs', null, '6900', 'Shop supplies', 'expense'),
];
const SHOP = 'fs:afs';
const MOVES = [
  both('40', '2026-06-01', -300000), both('10', '2026-06-01', 300000),
  both('13', '2026-05-01', 10000), both('10', '2026-05-01', -10000), both('13', '2026-06-01', -10000), both('10', '2026-06-01', 10000),
  both('61', '2026-07-01', 20000), both('10', '2026-07-01', -20000),
  both('40', '2027-03-01', -1000000), both('10', '2027-03-01', 1000000),
];
const data = (): ReportData => ({
  company: 'BMG',
  accounts: ACCOUNTS,
  opening: [ns('9', undefined, 3900), ns('10', undefined, 100000), ns('15', undefined, 500000), ns('77', undefined, -100000), ns('39', undefined, -503900)],
  netsuite: [
    ...MOVES.map((m) => m.netsuite),
    // In and out of Undeposited Funds the same month: debits and credits that come to nothing.
    { netsuite_account_id: '12', month: '2027-03-01', debit: '10000.00', credit: '10000.00' },
    ns('60', '2027-04-01', 200000), ns('10', '2027-04-01', -200000),
  ],
  fleetsuite: [
    ...MOVES.map((m) => m.fleetsuite),
    { account: '12', month: '2027-03-01', debit: '10000.00', credit: '10000.00' },
    fs('60', '2027-04-01', 210000), fs('10', '2027-04-01', -210000),
    fs(SHOP, '2027-05-01', 5000), fs('10', '2027-05-01', -5000),
  ],
});
const YEAR = { from: '2027-01-01', to: '2027-12-01' };

const doc = (over: Partial<AccountDocumentData> & Pick<AccountDocumentData, 'doc' | 'netsuite' | 'fleetsuite'>): AccountDocumentData => ({
  kind: null, type: null, number: null, month: null, date: null, name: null, memo: null, entry_no: null, entries: 1, ...over,
});
const found = (rows: AccountDocumentData[], over: Partial<AccountDocumentsData> = {}): AccountDocumentsData => {
  const sum = (side: 'netsuite' | 'fleetsuite') => (rows.reduce((s, r) => s + Math.round(Number(r[side]) * 100), 0) / 100).toFixed(2);
  return { documents: rows.length, differing: rows.filter((r) => r.netsuite !== r.fleetsuite).length, netsuite: sum('netsuite'), fleetsuite: sum('fleetsuite'), rows, ...over };
};
const SALE = { doc: '700', type: 'CashSale', number: 'CS100', month: '2027-03-01', date: '2027-03-10', name: 'Example Fleet Co' };
const DEPOSIT = { doc: '701', type: 'Deposit', number: 'D55', month: '2027-03-01', date: '2027-03-11' };
const CHECK = { doc: '702', type: 'Check', number: '1001', month: '2027-04-01', date: '2027-04-01', name: 'Example Landlord LLC', memo: 'April rent' };
const ENTRY = { doc: 'entry:5d2c7c62-87e4-4a5b-9b8e-3f6f0f6b1a01', date: '2027-05-04', entry_no: 12, memo: 'Shop supplies' };
const FOUND = new Map<string, AccountDocumentsData>([
  ['10', found([
    doc({ ...DEPOSIT, netsuite: '10000.00', fleetsuite: '10000.00' }),
    doc({ ...CHECK, netsuite: '-2000.00', fleetsuite: '-2100.00' }),
    doc({ ...ENTRY, netsuite: '0', fleetsuite: '-50.00' }),
  ])],
  ['12', found([doc({ ...SALE, netsuite: '10000.00', fleetsuite: '10000.00' }), doc({ ...DEPOSIT, netsuite: '-10000.00', fleetsuite: '-10000.00' })])],
  ['40', found([doc({ ...SALE, netsuite: '-10000.00', fleetsuite: '-10000.00' })])],
  ['60', found([doc({ ...CHECK, netsuite: '2000.00', fleetsuite: '2100.00' })])],
  [SHOP, found([doc({ ...ENTRY, netsuite: '0', fleetsuite: '50.00' })])],
]);

describe('the general ledger: which accounts it lists', () => {
  it('lists every account with a balance or anything moving it, balance sheet accounts first, each by number, as the trial balance does', () => {
    expect(ledgerAccounts(data(), YEAR)).toEqual([
      { key: '9', number: '900', name: 'Petty cash', inChart: true, moved: false },
      { key: '10', number: '1010', name: 'First Bank checking', inChart: true, moved: true },
      // Its debits and credits come to nothing in March, but they moved it.
      { key: '12', number: '1200', name: 'Undeposited Funds', inChart: true, moved: true },
      { key: '15', number: '1500', name: 'Trucks', inChart: true, moved: false },
      // 2026's net income comes in at January.
      { key: '39', number: '3900', name: 'Retained Earnings', inChart: true, moved: false },
      { key: '77', number: null, name: 'NetSuite account 77', inChart: false, moved: false },
      { key: '40', number: '4000', name: 'Sales', inChart: true, moved: true },
      { key: '60', number: '6000', name: 'Rent', inChart: true, moved: true },
      { key: SHOP, number: '6900', name: 'Shop supplies', inChart: true, moved: true },
    ]);
  });

  it('leaves out an account with nothing at either end and nothing moving it in the months, and counts only the months asked for', () => {
    // The prepaid came and went in 2026, and the old expense was 2026's alone.
    const keys = (range: { from: string; to: string }) => ledgerAccounts(data(), range).map((a) => [a.key, a.moved]);
    expect(keys(YEAR).map(([key]) => key)).not.toContain('13');
    expect(keys(YEAR).map(([key]) => key)).not.toContain('61');
    // Through March, the rent and the shop supplies haven't moved yet.
    expect(keys({ from: '2027-01-01', to: '2027-03-01' })).toEqual([
      ['9', false], ['10', true], ['12', true], ['15', false], ['39', false], ['77', false], ['40', true],
    ]);
    // 2026: the prepaid moved, the old expense too; the shop supplies didn't, and FleetSuite's own account only shows when it moves.
    expect(keys({ from: '2026-01-01', to: '2026-12-01' })).toEqual([
      ['9', false], ['10', true], ['13', true], ['15', false], ['39', false], ['77', false], ['40', true], ['61', true],
    ]);
    // A month either side of what's asked for doesn't count.
    expect(keys({ from: '2027-04-01', to: '2027-04-01' }).filter(([, moved]) => moved)).toEqual([['10', true], ['60', true]]);
  });

  it('counts an account moved when either side alone moved it', () => {
    const books = data();
    // The rent only in FleetSuite's books, and something on the trucks only in NetSuite's.
    books.netsuite = books.netsuite.filter((r) => r.netsuite_account_id !== '60');
    books.netsuite.push(ns('15', '2027-06-01', 100000));
    const moved = ledgerAccounts(books, YEAR).filter((a) => a.moved).map((a) => a.key);
    expect(moved).toEqual(['10', '12', '15', '40', '60', SHOP]);
  });

  it('lists an account with a balance on one side alone', () => {
    // The prepaid's reversal in June 2026 missing from one side's books leaves its 100.00 on that side alone.
    const missingFrom = (side: 'netsuite' | 'fleetsuite') => {
      const books = data();
      if (side === 'netsuite') books.netsuite = books.netsuite.filter((r) => !(r.netsuite_account_id === '13' && r.month === '2026-06-01'));
      else books.fleetsuite = books.fleetsuite.filter((r) => !(r.account === '13' && r.month === '2026-06-01'));
      return ledgerAccounts(books, YEAR).find((a) => a.key === '13');
    };
    for (const side of ['netsuite', 'fleetsuite'] as const) {
      expect([side, missingFrom(side)]).toEqual([side, { key: '13', number: '1300', name: 'Prepaid', inChart: true, moved: false }]);
    }
  });

  it("lists the accounts the chart doesn't have from either side's books, as the trial balance does: after those with numbers, by name", () => {
    const books = data();
    books.netsuite.push(ns('5', '2027-06-01', 70000), ns('10', '2027-06-01', -70000));
    books.fleetsuite.push(fs('fs:gone', '2027-06-01', 30000), fs('10', '2027-06-01', -30000));
    expect(ledgerAccounts(books, YEAR).filter((a) => !a.inChart)).toEqual([
      { key: '5', number: null, name: 'NetSuite account 5', inChart: false, moved: true },
      { key: '77', number: null, name: 'NetSuite account 77', inChart: false, moved: false },
      { key: 'fs:gone', number: null, name: 'NetSuite account fs:gone', inChart: false, moved: true },
    ]);
  });

  it('lists retained earnings when only the January it takes in last year\'s net income gives it a balance, at either end', () => {
    const retained = (opening: number | null) => {
      const books = data();
      books.opening = books.opening.filter((r) => r.netsuite_account_id !== '39');
      if (opening !== null) books.opening.push(ns('39', undefined, opening));
      return ledgerAccounts(books, YEAR).find((a) => a.key === '39');
    };
    // Nothing at the start of 2027, and 2026's 2,800.00 at its end.
    expect(retained(null)).toEqual({ key: '39', number: '3900', name: 'Retained Earnings', inChart: true, moved: false });
    // 2,800.00 of losses at the start, and 2026's net income bringing it to nothing.
    expect(retained(280000)).toEqual({ key: '39', number: '3900', name: 'Retained Earnings', inChart: true, moved: false });
  });
});

describe('the general ledger: each account', () => {
  const ledger = () => generalLedger(data(), YEAR, FOUND);
  const of = (key: string) => ledger().find((a) => a.key === key)!;

  it('runs a balance sheet account from its balance at the end of last year through each document to its balance at December 31', () => {
    const bank = of('10');
    expect(bank.rows.map((r) => [r.kind, r.balance])).toEqual([
      ['starting', { fleetsuite: 380000, netsuite: 380000 }],
      ['document', { fleetsuite: 1380000, netsuite: 1380000 }],
      ['document', { fleetsuite: 1170000, netsuite: 1180000 }],
      ['document', { fleetsuite: 1165000, netsuite: 1180000 }],
      ['ending', { fleetsuite: 1165000, netsuite: 1180000 }],
    ]);
    const check = bank.rows[2];
    expect(check.kind === 'document' && check.document).toMatchObject({
      type: 'Check', number: '1001', name: 'Example Landlord LLC', memo: 'April rent', date: '2027-04-01', fleetsuite: -210000, netsuite: -200000, only: null,
    });
    const entry = bank.rows[3];
    expect(entry.kind === 'document' && entry.document).toMatchObject({ type: 'Entry', number: 'Entry 12', only: 'fleetsuite' });
    // The documents come to the line on the trial balance.
    expect(bank.rows.at(-1)).toMatchObject({ reached: { fleetsuite: 1165000, netsuite: 1180000 } });
    expect([bank.documents, bank.listed, bank.short]).toEqual([3, 3, false]);
  });

  it("starts income and expenses from nothing and ends them on the year's total", () => {
    expect(of('60').rows.map((r) => [r.kind, r.balance])).toEqual([
      ['document', { fleetsuite: 210000, netsuite: 200000 }],
      ['ending', { fleetsuite: 210000, netsuite: 200000 }],
    ]);
    expect(of('40').rows.map((r) => r.kind)).toEqual(['document', 'ending']);
    expect(of(SHOP).rows.at(-1)).toMatchObject({ balance: { fleetsuite: 5000, netsuite: 0 } });
  });

  it("takes last year's net income into retained earnings at January, and carries a balance nothing moved", () => {
    expect(of('39').rows).toEqual([
      { kind: 'starting', balance: { fleetsuite: -503900, netsuite: -503900 } },
      { kind: 'closing', month: '2027-01-01', amount: { fleetsuite: -280000, netsuite: -280000 }, balance: { fleetsuite: -783900, netsuite: -783900 } },
      { kind: 'ending', balance: { fleetsuite: -783900, netsuite: -783900 }, reached: { fleetsuite: -783900, netsuite: -783900 } },
    ]);
    expect(of('15')).toMatchObject({
      rows: [
        { kind: 'starting', balance: { fleetsuite: 500000, netsuite: 500000 } },
        { kind: 'ending', balance: { fleetsuite: 500000, netsuite: 500000 }, reached: { fleetsuite: 500000, netsuite: 500000 } },
      ],
      documents: 0, listed: 0, short: false,
    });
    // A clearing account starts and ends at nothing, with what went through it between.
    expect(of('12').rows.map((r) => [r.kind, r.balance.netsuite])).toEqual([['starting', 0], ['document', 1000000], ['document', 0], ['ending', 0]]);
  });

  it("says when the copy of NetSuite's ledger doesn't hold what NetSuite's own totals say moved an account, and when not every document is listed", () => {
    const short = new Map(FOUND);
    short.set('60', found([doc({ ...CHECK, netsuite: '1500.00', fleetsuite: '2100.00' })]));
    short.set('40', found([doc({ ...SALE, netsuite: '-10000.00', fleetsuite: '-10000.00' })], { documents: 4 }));
    short.delete(SHOP);
    const ledger = generalLedger(data(), YEAR, short);
    const at = (key: string) => ledger.find((a) => a.key === key)!;
    expect(at('60')).toMatchObject({ short: true, documents: 1, listed: 1 });
    expect(at('60').rows.at(-1)).toMatchObject({ balance: { fleetsuite: 210000, netsuite: 200000 }, reached: { fleetsuite: 210000, netsuite: 150000 } });
    expect(at('40')).toMatchObject({ short: false, documents: 4, listed: 1 });
    // Not read: FleetSuite's side alone moved it, so NetSuite's copy isn't short, but its documents aren't listed.
    expect(at(SHOP)).toMatchObject({ short: false, documents: 0, listed: 0 });
    expect(at(SHOP).rows).toEqual([{ kind: 'ending', balance: { fleetsuite: 5000, netsuite: 0 }, reached: { fleetsuite: 0, netsuite: 0 } }]);
    expect(ledger.filter((a) => a.short).map((a) => a.key)).toEqual(['60']);
  });
});

describe('reading the general ledger', () => {
  const loaded = { company: '1084', data: { ...data(), company: '1084' } } as unknown as LoadedReports;
  /** gl_books_account_documents, each read answered a tick later (`fails` with an error), counting the reads under way at once. */
  const documentsRead = (fails?: string) => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let reading = 0;
    let most = 0;
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const nth = calls.push([name, args]);
      most = Math.max(most, (reading += 1));
      await new Promise((tick) => setTimeout(tick, 0));
      reading -= 1;
      return args.p_account === fails
        ? { data: null, error: { message: 'connection reset' } }
        : { data: found([], { documents: nth }), error: null };
    };
    return { service: { rpc } as unknown as SupabaseClient, calls, most: () => most };
  };

  it("reads the documents of only the accounts that moved, four at a time, as each account's own download does", async () => {
    const read = documentsRead();
    const ledger = await readLedger(read.service, loaded, YEAR);
    expect(read.calls).toEqual(['10', '12', '40', '60', SHOP].map((account) => ['gl_books_account_documents', {
      p_company: '1084', p_account: account, p_from: '2027-01-01', p_to: '2027-12-01', p_differs: false, p_limit: 20000,
    }]));
    expect(read.most()).toBe(4);
    // Each account with what was read for it.
    expect(ledger.map((a) => [a.key, a.documents])).toEqual([
      ['9', 0], ['10', 1], ['12', 2], ['15', 0], ['39', 0], ['77', 0], ['40', 3], ['60', 4], [SHOP, 5],
    ]);
  });

  it('reads no more once a read fails, and says what failed', async () => {
    const read = documentsRead('10');
    await expect(readLedger(read.service, loaded, YEAR)).rejects.toThrow('connection reset');
    // The other reads under way finish, and the shop supplies, still waiting for a reader, aren't read.
    await new Promise((settled) => setTimeout(settled, 20));
    expect(read.calls.map(([, args]) => args.p_account)).toEqual(['10', '12', '40', '60']);
  });
});
