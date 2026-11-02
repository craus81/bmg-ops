import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { buildAgings, type OpenDocumentData, type OpenDocumentsData } from './agings';
import {
  accountGroups, apRows, arAging, arRows, booksFinancials, booksMonths, booksPnl, booksPnlPeriod, notOpenOf,
  type BooksSource, type DocLink,
} from './money-screens';
import { UNNAMED, type PartyBalance, type PartyBalances, type PartyKind } from './party-balances';
import { report, type ReportAccount, type ReportAmount, type ReportData } from './reports';
import type { TbAmount } from './trial-balance';

// ── Made-up books ────────────────────────────────────────────────────────

const INCOME_STATEMENT = new Set(['income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense']);
const account = (id: string, ns: string | null, number: string | null, name: string, type: string, company: string | null = null): ReportAccount => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: INCOME_STATEMENT.has(type) ? 'income_statement' : 'balance_sheet', parent_id: null, company,
});

/** Made-up chart: two bank accounts with money, one without, and 1084's own; two cards; two tax accounts; Shop supplies is FleetSuite's own. */
const ACCOUNTS: ReportAccount[] = [
  account('a11', '11', '1010', 'Savings', 'bank'),
  account('a10', '10', '1000', 'Checking', 'bank'),
  account('a19', '19', '1090', 'Old bank', 'bank'),
  account('a18', '18', '1080', "1084's bank", 'bank', '1084'),
  account('a12', '12', '1200', 'Receivables', 'accounts_receivable'),
  account('a13', '13', '1300', 'Inventory', 'other_current_asset'),
  account('a20', '20', '2000', 'Payables', 'accounts_payable'),
  account('a23', '23', '2110', 'Amex card', 'credit_card'),
  account('a21', '21', '2100', 'Chase card', 'credit_card'),
  account('a22', '22', '2200', 'Sales tax', 'other_current_liability'),
  account('a24', '24', null, 'Use tax', 'other_current_liability'),
  account('a40', '40', '4000', 'Sales', 'income'),
  account('a41', '41', '4100', 'Freight income', 'income'),
  account('a50', '50', '5000', 'Cost of Goods Sold', 'cost_of_goods_sold'),
  account('a61', '61', '6010', 'Wages', 'expense'),
  account('a62', '62', '6020', 'Payroll taxes', 'expense'),
  account('a65', '65', '6500', 'Rent', 'expense'),
  account('afs', null, '6900', 'Shop supplies', 'expense'),
  account('a80', '80', '8000', 'Interest income', 'other_income'),
  account('a90', '90', '9000', 'Bank fees', 'other_expense'),
];
const SHOP = 'fs:afs';

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const opening = (acct: string, cents: number): TbAmount => ({ netsuite_account_id: acct, ...sides(cents) });
const fs = (acct: string, month: string, cents: number): ReportAmount => ({ account: acct, month, ...sides(cents) });

// Before 2025: $10,000 in Checking, $2,000 in Savings, $3,000 in 1084's bank,
// $500 owed on the Chase card, $70 of sales tax and $300 of bills.
const OPENING = [opening('10', 1000000), opening('11', 200000), opening('18', 300000), opening('21', -50000), opening('22', -7000), opening('20', -30000)];

const MOVES: Array<[string, Array<[string, number]>]> = [
  // A $1,000 sale with $70 of tax, and its $400 cost.
  ['2026-09-01', [['12', 107000], ['40', -100000], ['22', -7000], ['50', 40000], ['13', -40000]]],
  // Payroll, rent on the Chase card, shop supplies, interest, a bank fee, freight billed and a discount given.
  ['2026-10-01', [['61', 30000], ['62', 3000], ['10', -33000], ['65', 60000], ['21', -60000], [SHOP, 2500], ['10', -2500],
    ['80', -1000], ['10', 1000], ['90', 500], ['10', -500], ['41', -5000], ['12', 5000], ['40', 2000], ['12', -2000]]],
  // A customer pays $500, Amex refunds $15 of rent, and $5 more use tax is paid than owed.
  ['2026-11-01', [['10', 50000], ['12', -50000], ['23', 1500], ['65', -1500], ['24', 500], ['10', -500]]],
];

const books = (accounts = ACCOUNTS): ReportData => ({
  company: 'BMG',
  accounts,
  opening: OPENING,
  netsuite: [],
  fleetsuite: MOVES.flatMap(([month, list]) => list.map(([a, c]) => fs(a, month, c))),
});

// ── Made-up agings ───────────────────────────────────────────────────────

const TODAY = '2026-11-02';
const ACME = '11111111-1111-4111-8111-111111111111';
const BRAVO = '22222222-2222-4222-8222-222222222222';
const CREDIT_ONLY = '33333333-3333-4333-8333-333333333333';

const doc = (over: Partial<OpenDocumentData> & Pick<OpenDocumentData, 'party' | 'doc'>): OpenDocumentData => ({
  type: 'CustInvc', number: null, date: '2026-09-01', netsuite_due: null, fleetsuite_due: null,
  netsuite: '0', fleetsuite: '0', netsuite_lines: true, fleetsuite_lines: true, ...over,
});
/** A document open the same on both sides, amounts debit positive. */
const open = (over: Partial<OpenDocumentData> & Pick<OpenDocumentData, 'party' | 'doc'>, amount: string) =>
  doc({ netsuite: amount, fleetsuite: amount, netsuite_due: over.fleetsuite_due ?? null, ...over });

const balance = (party: string, name: string, fleetsuite: number, netsuite = fleetsuite): PartyBalance => ({
  party, name, netsuiteIds: [], opening: 0, fleetsuite, netsuite,
  documents: 0, differing: 0, differs: fleetsuite !== netsuite, members: [], membersCount: 0,
});
const balances = (kind: PartyKind, parties: PartyBalance[], unsplit = 0): PartyBalances => ({
  kind, accounts: [], parties, unsplit, openingComplete: true,
  totals: { fleetsuite: parties.reduce((s, p) => s + p.fleetsuite, unsplit), netsuite: parties.reduce((s, p) => s + p.netsuite, unsplit) },
  differing: 0,
});
const documents = (rows: OpenDocumentData[]): OpenDocumentsData => ({ linked: true, documents: rows.length, parties: [], rows });

/**
 * Acme owes $1,250: an invoice a month late (under a month by NetSuite's
 * due date), one not yet due, a credit memo two months old, and one NetSuite
 * still has open that FleetSuite's books paid. Bravo's $400 invoice is over 90 days late, but a $100 payment
 * isn't applied to it yet. Credit Only has nothing but a $20 credit memo.
 * One invoice names no customer FleetSuite knows, and $10 of the starting
 * entry isn't split by name.
 */
const customers = () => buildAgings(
  balances('customer', [
    balance(ACME, 'Acme Fleet', 125000, 131000),
    balance(BRAVO, 'Bravo Trucking', 30000),
    balance(CREDIT_ONLY, 'Credit Only Co', -2000),
    balance('', UNNAMED.customer, 7500),
  ], 1000),
  documents([
    open({ party: ACME, doc: '101', number: 'INV101', fleetsuite_due: '2026-10-01', netsuite_due: '2026-10-08' }, '800.00'),
    open({ party: ACME, doc: '102', number: 'INV102', date: '2026-10-21', fleetsuite_due: '2026-11-20' }, '500.00'),
    doc({ party: ACME, doc: '103', number: 'INV103', date: '2026-10-26', netsuite_due: '2026-11-25', fleetsuite_due: '2026-11-25', netsuite: '60.00' }),
    open({ party: ACME, doc: '107', number: 'CM7', type: 'CustCred' }, '-50.00'),
    open({ party: BRAVO, doc: '201', number: 'INV201', date: '2026-06-15', fleetsuite_due: '2026-07-15' }, '400.00'),
    open({ party: CREDIT_ONLY, doc: '309', number: 'CM9', type: 'CustCred', date: '2026-10-20' }, '-20.00'),
    open({ party: '', doc: '401', date: '2026-09-25', fleetsuite_due: '2026-10-25' }, '75.00'),
  ]),
  'customer',
  TODAY,
);

/**
 * BMG owes Parts Co $1,000 (a late bill less a bill credit, and $130 not in
 * an open bill; NetSuite still has a $45 bill open that FleetSuite's books
 * paid) and Steel Inc $200, not yet due.
 */
const vendors = () => buildAgings(
  balances('vendor', [balance('7001', 'Parts Co', 100000, 104500), balance('7002', 'Steel Inc', 20000)]),
  documents([
    open({ party: '7001', doc: '4001', number: 'VB1', type: 'VendBill', date: '2026-09-20', fleetsuite_due: '2026-10-20' }, '-900.00'),
    open({ party: '7001', doc: '4002', number: 'VC1', type: 'VendCred', date: '2026-10-25' }, '30.00'),
    doc({ party: '7001', doc: '4004', number: 'VB3', type: 'VendBill', date: '2026-10-28', netsuite_due: '2026-11-27', fleetsuite_due: '2026-11-27', netsuite: '-45.00' }),
    open({ party: '7002', doc: '4003', number: 'VB2', type: 'VendBill', date: '2026-10-30', fleetsuite_due: '2026-12-01' }, '-200.00'),
  ]),
  'vendor',
  TODAY,
);

const link: DocLink = (page, id) => `ns:${page}:${id}`;
const SOURCE: BooksSource = { company: 'BMG', name: 'BMG Fleet Installations', postedAt: '2026-11-02T13:48:00Z', postingError: null, postingPartial: false };
const TAX = ['22', '24', '99'];

// ── Tests ────────────────────────────────────────────────────────────────

describe('accountGroups', () => {
  it("lists each bank, card, payable and sales tax account the company's books use with what's on it, by number", () => {
    expect(accountGroups(books(), '2026-11-01', TAX)).toEqual({
      success: true,
      bank: [
        { id: '10', name: '1000 Checking', type: 'bank', balance: 10145 },
        { id: '11', name: '1010 Savings', type: 'bank', balance: 2000 },
      ],
      card: [
        { id: '21', name: '2100 Chase card', type: 'credit_card', balance: 1100 },
        { id: '23', name: '2110 Amex card', type: 'credit_card', balance: -15 },
      ],
      ap: [{ id: '20', name: '2000 Payables', type: 'accounts_payable', balance: 300 }],
      salesTax: [
        { id: '22', name: '2200 Sales tax', type: 'other_current_liability', balance: 140 },
        { id: '24', name: 'Use tax', type: 'other_current_liability', balance: -5 },
      ],
      has: { bank: true, card: true, ap: true, salesTax: true },
    });
  });

  it('reads the balances at the end of the month asked for', () => {
    const october = accountGroups(books(), '2026-10-01', TAX);
    expect(october.bank).toEqual([
      { id: '10', name: '1000 Checking', type: 'bank', balance: 9650 },
      { id: '11', name: '1010 Savings', type: 'bank', balance: 2000 },
    ]);
    expect(october.card).toEqual([{ id: '21', name: '2100 Chase card', type: 'credit_card', balance: 1100 }]);
    expect(october.salesTax).toEqual([{ id: '22', name: '2200 Sales tax', type: 'other_current_liability', balance: 140 }]);
  });

  it("has no sales tax accounts until NetSuite's lists are read, and says which kinds the chart has none of", () => {
    const none = accountGroups(books(ACCOUNTS.filter((a) => a.account_type !== 'credit_card')), '2026-11-01', null);
    expect(none.salesTax).toEqual([]);
    expect(none.card).toEqual([]);
    expect(none.has).toEqual({ bank: true, card: false, ap: true, salesTax: false });
    expect(accountGroups(books(), '2026-11-01', []).has.salesTax).toBe(false);
    expect(accountGroups(books(ACCOUNTS.filter((a) => a.account_type !== 'bank' && a.account_type !== 'accounts_payable')), '2026-11-01', TAX).has)
      .toEqual({ bank: false, card: true, ap: false, salesTax: true });
  });

  it("leaves out another company's accounts, even with money on them, and keeps one limited to this company", () => {
    const own = ACCOUNTS.map((a) => (a.id === 'a11' ? { ...a, company: 'BMG' } : a));
    expect(accountGroups(books(own), '2026-11-01', TAX).bank.map((a) => a.id)).toEqual(['10', '11']);
    expect(accountGroups({ ...books(), company: '1084' }, '2026-11-01', TAX).bank.map((a) => a.id)).toEqual(['10', '11', '18']);
  });
});

describe('arAging', () => {
  it("is the receivable accounts' balance, aged by FleetSuite's open documents, with what isn't in one apart", () => {
    expect(arAging(customers())).toEqual({
      total: 1615,
      pastDue: 1205,
      openCount: 6,
      buckets: { current: 500, d1_30: 55, d31_60: 800, d61_90: -50, d90plus: 400 },
      topOverdue: [
        { key: `e:${ACME}`, customer: 'Acme Fleet', amount: 750, days: 32 },
        { key: `e:${BRAVO}`, customer: 'Bravo Trucking', amount: 400, days: 110 },
        { key: `n:${UNNAMED.customer}`, customer: UNNAMED.customer, amount: 75, days: 8 },
      ],
      notOpen: -90,
    });
  });

  it('lists the six customers most overdue, the largest first, then by name', () => {
    const names = ['Golf', 'Foxtrot', 'Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha', 'Hotel'];
    const party = (i: number) => `${i}0000000-0000-4000-8000-000000000000`;
    const many = buildAgings(
      balances('customer', names.map((name, i) => balance(party(i), name, i < 2 ? 10000 : 20000 + i))),
      documents(names.map((_, i) => open({ party: party(i), doc: `9${i}`, fleetsuite_due: '2026-10-02' }, i < 2 ? '100.00' : `${200 + i / 100}`))),
      'customer',
      TODAY,
    );
    expect(arAging(many).topOverdue.map((o) => [o.customer, o.amount])).toEqual([
      ['Hotel', 200.07], ['Alpha', 200.06], ['Bravo', 200.05], ['Charlie', 200.04], ['Delta', 200.03], ['Echo', 200.02],
    ]);
    const tied = buildAgings(
      balances('customer', [balance(party(0), 'Zulu', 10000), balance(party(1), 'Yankee', 10000)]),
      documents([open({ party: party(0), doc: '1', fleetsuite_due: '2026-10-02' }, '100.00'), open({ party: party(1), doc: '2', fleetsuite_due: '2026-10-02' }, '100.00')]),
      'customer',
      TODAY,
    );
    expect(arAging(tied).topOverdue.map((o) => o.customer)).toEqual(['Yankee', 'Zulu']);
  });

  it('says how late an account is by its latest invoice, not a credit memo', () => {
    const late = buildAgings(
      balances('customer', [balance(ACME, 'Acme Fleet', 110000)]),
      documents([
        open({ party: ACME, doc: '1', number: 'INV1', fleetsuite_due: '2026-10-01' }, '300.00'),
        open({ party: ACME, doc: '2', number: 'INV2', fleetsuite_due: '2026-07-15' }, '900.00'),
        open({ party: ACME, doc: '3', number: 'CM3', type: 'CustCred', date: '2026-06-01' }, '-100.00'),
      ]),
      'customer',
      TODAY,
    );
    expect(arAging(late).topOverdue).toEqual([{ key: `e:${ACME}`, customer: 'Acme Fleet', amount: 1100, days: 110 }]);
  });

  it('comes to nothing with nothing open', () => {
    const empty = buildAgings(balances('customer', []), null, 'customer', TODAY);
    expect(arAging(empty)).toEqual({
      total: 0, pastDue: 0, openCount: 0, buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 }, topOverdue: [], notOpen: 0,
    });
  });
});

describe('booksFinancials', () => {
  it('adds up the tiles: cash, what customers owe, and what BMG owes on bills, cards and sales tax', () => {
    const v = vendors();
    expect(v.totals.balance.fleetsuite).toBe(120000);
    expect(booksFinancials(accountGroups(books(), '2026-11-01', TAX), customers(), v.totals.balance.fleetsuite, SOURCE)).toEqual({
      ar: arAging(customers()),
      // A card or tax account in credit isn't owed, so Amex and use tax count nothing.
      ap: { vendorBills: 1200, cardOwed: 1100, salesTax: 140, total: 2440 },
      cash: 12145,
      net: 11320,
      config: { balancesOk: true, balancesError: null, bankConfigured: true, cardConfigured: true, apConfigured: true, salesTaxConfigured: true },
      books: SOURCE,
    });
  });

  it("counts no sales tax before NetSuite's lists are read, and nets to what's left", () => {
    const shown = booksFinancials(accountGroups(books(), '2026-11-01', null), customers(), 120000, SOURCE);
    expect(shown.ap).toEqual({ vendorBills: 1200, cardOwed: 1100, salesTax: 0, total: 2300 });
    expect(shown.net).toBe(11460);
    expect(shown.config.salesTaxConfigured).toBe(false);
  });

  it('says which kinds of account the chart has none of', () => {
    const none = books(ACCOUNTS.filter((a) => !['bank', 'credit_card', 'accounts_payable'].includes(a.account_type)));
    const shown = booksFinancials(accountGroups(none, '2026-11-01', TAX), customers(), 0, SOURCE);
    expect([shown.cash, shown.ap.cardOwed]).toEqual([0, 0]);
    expect(shown.config).toEqual({
      balancesOk: true, balancesError: null, bankConfigured: false, cardConfigured: false, apConfigured: false, salesTaxConfigured: true,
    });
  });

  it('counts an overdrawn bank account against cash', () => {
    const groups = {
      ...accountGroups(books(), '2026-11-01', TAX),
      bank: [{ id: '10', name: 'x', type: 'bank', balance: 500 }, { id: '11', name: 'y', type: 'bank', balance: -120.5 }],
    };
    expect(booksFinancials(groups, customers(), 120000, SOURCE).cash).toBe(379.5);
  });

  it('keeps cents exact when they add up', () => {
    const groups = {
      ...accountGroups(books(), '2026-11-01', TAX),
      bank: [{ id: '10', name: 'x', type: 'bank', balance: 0.1 }, { id: '11', name: 'y', type: 'bank', balance: 0.2 }],
      card: [{ id: '21', name: 'z', type: 'credit_card', balance: 0.7 }],
      salesTax: [],
    };
    const shown = booksFinancials(groups, buildAgings(balances('customer', []), null, 'customer', TODAY), 0, SOURCE);
    expect(shown.cash).toBe(0.3);
    expect(shown.ap.total).toBe(0.7);
    expect(shown.net).toBe(-0.4);
  });
});

describe('arRows and apRows', () => {
  const invoiceFacts = new Map([['101', { total: 1000, note: 'PO-77' }], ['107', { total: 50, note: null }], ['201', { total: 400, note: null }]]);

  it("lists every open invoice and credit memo with FleetSuite's open amount and due date, the customers' order kept", () => {
    expect(arRows(customers(), invoiceFacts, link)).toEqual([
      {
        id: '107', tranid: 'CM7', date: '2026-09-01', dueDate: null, po: null, customer: 'Acme Fleet', entityId: ACME,
        total: -50, unpaid: -50, daysPastDue: 62, bucket: 'd61_90', nsUrl: 'ns:custcred:107', creditMemo: true,
      },
      {
        id: '101', tranid: 'INV101', date: '2026-09-01', dueDate: '2026-10-01', po: 'PO-77', customer: 'Acme Fleet', entityId: ACME,
        total: 1000, unpaid: 800, daysPastDue: 32, bucket: 'd31_60', nsUrl: 'ns:custinvc:101',
      },
      {
        id: '102', tranid: 'INV102', date: '2026-10-21', dueDate: '2026-11-20', po: null, customer: 'Acme Fleet', entityId: ACME,
        total: 500, unpaid: 500, daysPastDue: 0, bucket: 'current', nsUrl: 'ns:custinvc:102',
      },
      {
        id: '201', tranid: 'INV201', date: '2026-06-15', dueDate: '2026-07-15', po: null, customer: 'Bravo Trucking', entityId: BRAVO,
        total: 400, unpaid: 400, daysPastDue: 110, bucket: 'd90plus', nsUrl: 'ns:custinvc:201',
      },
      {
        id: '401', tranid: '401', date: '2026-09-25', dueDate: '2026-10-25', po: null, customer: UNNAMED.customer, entityId: null,
        total: 75, unpaid: 75, daysPastDue: 8, bucket: 'd1_30', nsUrl: 'ns:custinvc:401',
      },
      {
        id: '309', tranid: 'CM9', date: '2026-10-20', dueDate: null, po: null, customer: 'Credit Only Co', entityId: CREDIT_ONLY,
        total: -20, unpaid: -20, daysPastDue: 13, bucket: 'd1_30', nsUrl: 'ns:custcred:309', creditMemo: true,
      },
    ]);
  });

  it("adds up, with what isn't in an open invoice, to the A/R tile", () => {
    const c = customers();
    const listed = arRows(c, invoiceFacts, link).reduce((sum, r) => sum + r.unpaid * 100, 0);
    expect(notOpenOf(c)).toBe(-90);
    expect(listed / 100 + notOpenOf(c)).toBe(arAging(c).total);
  });

  it('lists every open bill and bill credit with its memo, a credit negative', () => {
    const v = vendors();
    expect(apRows(v, new Map([['4001', { total: 900, note: 'Oct parts' }], ['4002', { total: 30, note: 'Return' }]]), link)).toEqual([
      {
        id: '4001', tranid: 'VB1', date: '2026-09-20', dueDate: '2026-10-20', vendor: 'Parts Co', memo: 'Oct parts',
        total: 900, unpaid: 900, daysPastDue: 13, nsUrl: 'ns:vendbill:4001',
      },
      {
        id: '4002', tranid: 'VC1', date: '2026-10-25', dueDate: null, vendor: 'Parts Co', memo: 'Return',
        total: -30, unpaid: -30, daysPastDue: 8, nsUrl: 'ns:vendcred:4002', billCredit: true,
      },
      {
        id: '4003', tranid: 'VB2', date: '2026-10-30', dueDate: '2026-12-01', vendor: 'Steel Inc', memo: null,
        total: 200, unpaid: 200, daysPastDue: 0, nsUrl: 'ns:vendbill:4003',
      },
    ]);
    expect(notOpenOf(v)).toBe(130);
  });
});

describe('booksPnl', () => {
  const PAYROLL = new Set(['61', '62']);

  it("sums each income and expense account's entries for the months, income and costs positive, payroll apart", () => {
    expect(booksPnl(books(), '2026-10-01', '2026-10-01', PAYROLL)).toEqual({
      // $50 of freight less a $20 discount.
      income: 30,
      cogs: 0,
      expense: 625,
      payroll: 330,
      otherIncome: 10,
      otherExpense: 5,
      grossMargin: 30,
      grossMarginPct: 100,
      netProfit: -920,
      netProfitPct: -3066.67,
      laborPct: 1100,
      accountCount: 8,
    });
  });

  it("covers every month from the first through the last, and ties to Reports' profit and loss", () => {
    const data = books();
    const pnl = booksPnl(data, '2026-09-01', '2026-11-01', PAYROLL);
    expect(pnl).toEqual({
      income: 1030, cogs: 400, expense: 610, payroll: 330, otherIncome: 10, otherExpense: 5,
      grossMargin: 630, grossMarginPct: 61.17, netProfit: -305, netProfitPct: -29.61, laborPct: 32.04, accountCount: 9,
    });
    const lines = report(data, 'profit_and_loss', { from: '2026-09-01', to: '2026-11-01' }).lines;
    const line = (label: string) => lines.find((l) => l.label === label)?.fleetsuite;
    expect(line('Total income')).toBe(103000);
    expect(line('Gross profit')).toBe(63000);
    expect(line('Net income')).toBe(-30500);
  });

  it('puts payroll in expenses when no payroll accounts are named, and counts nothing outside the months', () => {
    expect(booksPnl(books(), '2026-09-01', '2026-11-01', new Set())).toMatchObject({ expense: 940, payroll: 0, laborPct: 0, netProfit: -305 });
    expect(booksPnl(books(), '2026-11-01', '2026-11-01', PAYROLL)).toMatchObject({ income: 0, expense: -15, accountCount: 1, grossMarginPct: null });
    expect(booksPnl(books(), '2026-12-01', '2027-01-01', PAYROLL)).toEqual({
      income: 0, cogs: 0, expense: 0, payroll: 0, otherIncome: 0, otherExpense: 0,
      grossMargin: 0, grossMarginPct: null, netProfit: 0, netProfitPct: null, laborPct: null, accountCount: 0,
    });
  });

  it("doesn't count an account whose entries net to nothing, nor a balance sheet account", () => {
    const data = books();
    data.fleetsuite.push(fs('65', '2026-12-01', 4000), fs('65', '2026-12-01', -4000), fs('10', '2026-12-01', 9900));
    expect(booksPnl(data, '2026-12-01', '2026-12-01', PAYROLL).accountCount).toBe(0);
  });
});

describe('booksPnlPeriod', () => {
  it("is the period's months from FleetSuite's books, with what customers paid, and no error", () => {
    const def = { key: 'last-month' as const, label: 'Last month', from: '2026-10-01', to: '2026-10-31', directional: false };
    const collections = { total: 2200, count: 6 };
    expect(booksPnlPeriod(books(), def, new Set(['61', '62']), collections)).toEqual({
      ...def, pnl: booksPnl(books(), '2026-10-01', '2026-10-01', new Set(['61', '62'])), collections, error: null,
    });
  });

  it('takes in the whole of each month a period touches', () => {
    const def = { key: 'qtd' as const, label: 'Quarter to date', from: '2026-10-01', to: '2026-11-02', directional: true };
    expect(booksPnlPeriod(books(), def, new Set(), null)).toMatchObject({
      key: 'qtd', directional: true, collections: null, error: null, pnl: { income: 30, expense: 940, accountCount: 8 },
    });
    const midMonth = { key: 'mtd' as const, label: 'This month', from: '2026-10-15', to: '2026-10-20', directional: true };
    expect(booksPnlPeriod(books(), midMonth, new Set(), null).pnl).toEqual(booksPnl(books(), '2026-10-01', '2026-10-01', new Set()));
  });
});

describe('booksMonths', () => {
  it("is each month's profit and loss on its own, payroll left in expenses, a month with nothing at nothing", () => {
    const months = booksMonths(books(), ['2026-08', '2026-09', '2026-10', '2026-11']);
    expect([...months.keys()]).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(months.get('2026-09')).toEqual(booksPnl(books(), '2026-09-01', '2026-09-01', new Set()));
    expect(months.get('2026-09')).toMatchObject({ income: 1000, cogs: 400, expense: 0, netProfit: 600 });
    // Wages and payroll taxes stay in expenses: Financial History has no payroll of its own.
    expect(months.get('2026-10')).toMatchObject({ income: 30, expense: 955, payroll: 0, netProfit: -920 });
    expect(months.get('2026-11')).toMatchObject({ income: 0, expense: -15, netProfit: 15 });
    expect(months.get('2026-08')).toMatchObject({ income: 0, netProfit: 0, accountCount: 0 });
    expect(booksMonths(books(), []).size).toBe(0);
  });
});
