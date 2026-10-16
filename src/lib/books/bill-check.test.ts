import { describe, it, expect } from 'vitest';
import type { ChartAccount, InvoiceBooks, NetSuitePosting } from './invoice-check';
import type { BillAccounts, BillItem, BillLine } from './bill-rule';
import {
  billReasons, checkBill, checkBillMonth, itemsWithoutAccount, lineSigns, pickPayables, pickReceivedAccount, withOwnBillAmounts, workOutBillMonth,
  type BillMonthData, type WorkedBill,
} from './bill-check';

// Made-up books: '200' and '201' payables, '205' received not billed, '206'
// landed cost clearing, '130' inventory, '110' undeposited funds, '530'
// subcontractors, '610' shop supplies, '480' vendor discounts.
const NAMES: Record<string, [string, string]> = {
  '200': ['2000 Accounts Payable', 'accounts_payable'], '201': ['2010 Payables Other', 'accounts_payable'],
  '205': ['2050 Received Not Billed', 'other_current_liability'], '206': ['2060 Landed Cost Clearing', 'other_current_liability'],
  '130': ['1300 Inventory', 'other_current_asset'], '110': ['1100 Undeposited Funds', 'other_current_asset'],
  '530': ['5300 Subcontractors', 'expense'], '610': ['6100 Shop Supplies', 'expense'], '480': ['4800 Vendor Discounts', 'other_income'],
};
const TYPES = new Map(Object.entries(NAMES).map(([id, [, type]]) => [id, type]));
const account = (id: string) => NAMES[id]?.[0] ?? `NetSuite account ${id}`;
const chartAccount = (id: string, fields: Partial<ChartAccount> = {}): ChartAccount => ({
  netsuite_account_id: id, number: NAMES[id][0].split(' ')[0], name: NAMES[id][0].split(' ').slice(1).join(' '), account_type: NAMES[id][1],
  company: null, active: true, is_summary: false, ...fields,
});
// BMG's chart: one payables account; '201' is inactive.
const CHART = Object.keys(NAMES).map((id) => chartAccount(id, id === '201' ? { active: false } : {}));

const ITEMS = new Map<string, BillItem>([
  ['901', { number: 'WIDGET-1', type: 'InvtPart', assetAccount: '130', expenseAccount: null, incomeAccount: null }],
  ['902', { number: 'SUPPLY-2', type: 'NonInvtPart', assetAccount: null, expenseAccount: '610', incomeAccount: null }],
]);
const ACCOUNTS: BillAccounts = { items: ITEMS, payables: '200', received: '205' };
const CTX = { accounts: ACCOUNTS, accountTypes: TYPES };

const ns = (lineId: string, acct: string, cents: number): NetSuitePosting => ({ lineId, account: acct, cents });
const expense = (lineId: string, acct: string | null, cents: number | null): BillLine => ({ lineId, itemId: null, account: acct, cents, tax: false });
const line = (lineId: string, itemId: string, cents: number | null): BillLine => ({ lineId, itemId, account: null, cents, tax: false });

// A $650.00 bill from a purchase order: an installer's labor, supplies, and stock already received.
const LINES = [expense('1', '530', 50000), line('2', '902', 12000), line('3', '901', 3000)];
// NetSuite's posting of it: payables credited, each line where it goes.
const POSTED = [ns('0', '200', -65000), ns('1', '530', 50000), ns('2', '610', 12000), ns('3', '205', 3000)];

const bill = (lines: BillLine[] | null = LINES, netsuite = POSTED, ordered: boolean | null = true, cents: number | null = 65000, ctx = CTX) =>
  checkBill({ cents, lines, ordered, netsuite }, ctx);
const rows = (c: ReturnType<typeof checkBill>) =>
  c.rows.map((r) => [r.lineId, r.role, r.fleetsuite && [r.fleetsuite.account, r.fleetsuite.cents], r.netsuite && [r.netsuite.account, r.netsuite.cents], r.same]);

describe('pickPayables', () => {
  it('is the company\'s only payables account, with the vendor\'s own allowed when it\'s the company\'s', () => {
    expect(pickPayables(CHART, 'BMG', [], account)).toEqual({ candidates: new Set(['200']), fallback: '200', note: null });
    // Limited to another company, a summary, or with no NetSuite id: never one.
    const others = [...CHART, chartAccount('201', { company: '1084' })];
    expect(pickPayables(others, 'BMG', [], account).candidates).toEqual(new Set(['200']));
    expect(pickPayables(others, '1084', [], account).candidates).toEqual(new Set(['200', '201']));
  });

  it('takes the one the month\'s bills used most when there are more, and says so', () => {
    const two = [...CHART.filter((a) => a.netsuite_account_id !== '201'), chartAccount('201')];
    expect(pickPayables(two, 'BMG', [ns('0', '201', -100), ns('0', '201', -200), ns('0', '200', -300), ns('1', '530', 600)], account)).toEqual({
      candidates: new Set(['200', '201']),
      fallback: '201',
      note: "BMG can use 2 payables accounts, so for a vendor with none of its own FleetSuite used 2010 Payables Other, the one NetSuite's bills used most this month.",
    });
    // The lower NetSuite id on a tie, and the first in the chart with nothing to go by.
    expect(pickPayables(two, 'BMG', [ns('0', '201', -1), ns('0', '200', -1)], account).fallback).toBe('200');
    expect(pickPayables(two, 'BMG', [], account).note).toBe(
      'BMG can use 2 payables accounts, so for a vendor with none of its own FleetSuite used 2000 Accounts Payable, the first in the chart.',
    );
  });

  it('is none when the chart has none for the company', () => {
    expect(pickPayables(CHART.filter((a) => a.account_type !== 'accounts_payable'), 'BMG', [], account)).toEqual({
      candidates: new Set(), fallback: null, note: 'The chart of accounts has no payables account BMG can use.',
    });
  });
});

describe('pickReceivedAccount', () => {
  it('is the liability the company\'s item receipts credit, the one most of them do when there are more', () => {
    expect(pickReceivedAccount([{ account: '205', documents: 40 }], 'BMG', TYPES, account)).toEqual({ account: '205', note: null });
    expect(pickReceivedAccount([{ account: '206', documents: 3 }, { account: '205', documents: 40 }], 'BMG', TYPES, account)).toEqual({
      account: '205',
      note: "NetSuite's item receipts for BMG credit 2 accounts, so FleetSuite takes received stock off 2050 Received Not Billed, the one most of them credit.",
    });
    expect(pickReceivedAccount([{ account: '206', documents: 3 }, { account: '205', documents: 3 }], 'BMG', TYPES, account).account).toBe('205');
  });

  it('is never payables, an asset, income or an account the chart doesn\'t have, and none when receipts credit nothing else', () => {
    expect(pickReceivedAccount([
      { account: '200', documents: 9 }, { account: '130', documents: 9 }, { account: '480', documents: 9 }, { account: '999', documents: 9 },
      { account: '205', documents: 0 },
    ], 'BMG', TYPES, account)).toEqual({ account: null, note: null });
  });
});

describe('lineSigns', () => {
  const doc = (type: 'VendBill' | 'VendCred', ...amounts: Array<string | null>) => ({ type, lines: amounts.map((amount) => ({ amount })) });

  it('takes NetSuite\'s lines as they come when a bill\'s add up to more than nothing and a bill credit\'s to less', () => {
    expect(lineSigns([doc('VendBill', '500.00', '-20.00'), doc('VendCred', '-30.00')])).toEqual({ VendBill: 1, VendCred: 1 });
  });

  it('turns them round when most of the month\'s say NetSuite signs them the other way', () => {
    expect(lineSigns([doc('VendBill', '-500.00'), doc('VendBill', '-20.00'), doc('VendBill', '5.00'), doc('VendCred', '30.00')]))
      .toEqual({ VendBill: -1, VendCred: -1 });
  });

  it('goes by the GL when the month has no say: no documents, lines not copied, or lines that come to nothing', () => {
    expect(lineSigns([])).toEqual({ VendBill: 1, VendCred: 1 });
    expect(lineSigns([{ type: 'VendBill', lines: null }, doc('VendBill', '50.00', '-50.00'), doc('VendCred', null)])).toEqual({ VendBill: 1, VendCred: 1 });
    expect(lineSigns([doc('VendBill', '-5.00'), doc('VendBill', '5.00')])).toEqual({ VendBill: 1, VendCred: 1 });
  });
});

describe('withOwnBillAmounts', () => {
  const items = new Map<string, BillItem>([...ITEMS, ['904', { number: 'DISC', type: 'Discount', assetAccount: null, expenseAccount: null, incomeAccount: '480' }]]);
  const owns = (...amounts: Array<string | null | undefined>) => amounts.map((a) => (a === undefined ? {} : { own_amount: a }));
  // $100.00 of stock less 8%: NetSuite shares the discount out over the line above it in the net amounts.
  const NET = [line('1', '901', 9200), line('2', '904', 0)];

  it('takes the lines at their own amounts when they come to the same, the discount on a line of its own', () => {
    expect(withOwnBillAmounts(NET, owns('100.00', '-8.00'), items)).toEqual({ amounts: 'own', lines: [line('1', '901', 10000), line('2', '904', -800)] });
    // Own amounts signed the other way round from the lines.
    expect(withOwnBillAmounts(NET, owns('-100.00', '8.00'), items)).toEqual({ amounts: 'own', lines: [line('1', '901', 10000), line('2', '904', -800)] });
  });

  it('keeps the net amounts when the own ones change nothing, or some line that posts has none', () => {
    expect(withOwnBillAmounts(LINES, owns('500.00', '120.00', '30.00'), items)).toEqual({ amounts: 'net', lines: LINES });
    expect(withOwnBillAmounts(LINES, owns('-500.00', '-120.00', '-30.00'), items)).toEqual({ amounts: 'net', lines: LINES });
    // Copied before the copy kept them, or NetSuite didn't give one.
    expect(withOwnBillAmounts(NET, owns(undefined, '-8.00'), items)).toEqual({ amounts: 'net', lines: NET });
    expect(withOwnBillAmounts(NET, owns('100.00', null), items)).toEqual({ amounts: 'net', lines: NET });
  });

  it('keeps the net amounts, and says so, when the own ones don\'t come to the same or can\'t be read', () => {
    expect(withOwnBillAmounts(NET, owns('100.00', '-5.00'), items)).toEqual({ amounts: 'unfit', lines: NET });
    expect(withOwnBillAmounts(NET, owns('lots', '-8.00'), items)).toEqual({ amounts: 'unfit', lines: NET });
  });

  it('leaves tax, unreadable lines and lines that never post as they are', () => {
    const lines = [line('1', '901', 9200), line('2', '-2', 9200), line('3', '904', 0), { ...expense('4', null, 500), tax: true }, line('5', '902', null)];
    expect(withOwnBillAmounts(lines, owns('100.00', '100.00', '-8.00', '7.00', '3.00'), items)).toEqual({
      amounts: 'own',
      lines: [line('1', '901', 10000), line('2', '-2', 9200), line('3', '904', -800), { ...expense('4', null, 500), tax: true }, line('5', '902', null)],
    });
    // Nothing to go by: nothing changes.
    expect(withOwnBillAmounts([], [], items)).toEqual({ amounts: 'net', lines: [] });
  });
});

describe('checkBill', () => {
  it('matches a bill NetSuite posts the same, account by account', () => {
    const c = bill();
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      ['payables', 'payables', ['200', -65000], ['200', -65000], true],
      ['account:530', 'expense', ['530', 50000], ['530', 50000], true],
      ['account:610', 'item', ['610', 12000], ['610', 12000], true],
      ['account:205', 'received', ['205', 3000], ['205', 3000], true],
    ]);
    // The entry it posts, line by line, payables first.
    expect(c.lines.map((l) => [l.lineId, l.account, l.cents, l.itemNumber, l.role])).toEqual([
      ['payables', '200', -65000, null, 'payables'],
      ['1', '530', 50000, null, 'expense'],
      ['2', '610', 12000, 'SUPPLY-2', 'item'],
      ['3', '205', 3000, 'WIDGET-1', 'received'],
    ]);
    // However NetSuite splits its lines over the accounts.
    expect(bill(LINES, [ns('0', '200', -65000), ns('5', '530', 20000), ns('6', '530', 30000), ns('2', '610', 12000), ns('3', '205', 3000)]).status)
      .toBe('matches');
  });

  it('matches a bill credit, the other way round', () => {
    const c = bill([line('1', '902', -12000)], [ns('0', '200', 12000), ns('1', '610', -12000)], false, 12000);
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      ['payables', 'payables', ['200', 12000], ['200', 12000], true],
      ['account:610', 'item', ['610', -12000], ['610', -12000], true],
    ]);
  });

  it('waits for the GL copy, then for the lines, and matches $0 with nothing on either side', () => {
    expect(bill(LINES, [])).toEqual({ status: 'waiting', waiting: 'gl', problems: [], rows: [], lines: [] });
    expect(bill(null)).toEqual({ status: 'waiting', waiting: 'lines', problems: [], rows: [], lines: [] });
    expect(bill([], [], true, 0)).toEqual({ status: 'matches', problems: [], rows: [], lines: [] });
    // An account NetSuite's lines come to nothing on is the same as none.
    expect(bill([], [ns('0', '200', 500), ns('1', '200', -500)], true, 0).status).toBe('matches');
  });

  it('leaves out an account the rule\'s lines come to nothing on, as it does NetSuite\'s', () => {
    // A discount taken and given back on the bill itself.
    const c = bill([...LINES, expense('4', '480', -2500), expense('5', '480', 2500)], [...POSTED, ns('4', '480', -2500), ns('5', '480', 2500)]);
    expect(c.status).toBe('matches');
    expect(rows(c).map((r) => r[0])).toEqual(['payables', 'account:530', 'account:610', 'account:205']);
  });

  it('differs when NetSuite puts something elsewhere, posts a different amount, or posts more', () => {
    const elsewhere = bill(LINES, [ns('0', '200', -65000), ns('1', '530', 50000), ns('2', '610', 12000), ns('3', '130', 3000)]);
    expect(elsewhere.status).toBe('differs');
    expect(rows(elsewhere).slice(3)).toEqual([
      ['account:205', 'received', ['205', 3000], null, false],
      ['account:130', 'other', null, ['130', 3000], false],
    ]);
    const amount = bill(LINES, [ns('0', '200', -66000), ns('1', '530', 51000), ns('2', '610', 12000), ns('3', '205', 3000)]);
    expect(rows(amount).map((r) => r[4])).toEqual([false, false, true, true]);
    // Another payables account than the rule's shows as payables.
    const payables = bill(LINES, [ns('0', '201', -65000), ns('1', '530', 50000), ns('2', '610', 12000), ns('3', '205', 3000)]);
    expect(rows(payables)).toContainEqual(['account:201', 'payables', null, ['201', -65000], false]);
  });

  it('can\'t work out what the rule can\'t, and still shows what NetSuite posted', () => {
    const c = bill([line('1', '999', 65000)]);
    expect(c.status).toBe('unworkable');
    expect(c.problems).toEqual([{ kind: 'not_copied', lineId: '1', itemId: '999' }]);
    // A document posts whole or not at all.
    expect(c.lines).toEqual([]);
    expect(rows(c).map((r) => [r[0], r[2], r[4]])).toEqual([
      ['account:200', null, false], ['account:530', null, false], ['account:610', null, false], ['account:205', null, false],
    ]);
  });
});

describe('billReasons', () => {
  const reasons = (c: ReturnType<typeof checkBill>, type: 'VendBill' | 'VendCred' = 'VendBill') => billReasons(c, type, account);

  it('says once that NetSuite used another account for the same amount', () => {
    const c = bill(LINES, [ns('0', '201', -65000), ns('1', '530', 50000), ns('2', '610', 12000), ns('3', '130', 3000)]);
    expect(reasons(c)).toEqual([
      { key: 'swap|payables|200|201', text: 'Payables: FleetSuite used 2000 Accounts Payable, NetSuite 2010 Payables Other.' },
      { key: 'swap|received|205|130', text: 'Received stock: FleetSuite used 2050 Received Not Billed, NetSuite 1300 Inventory.' },
    ]);
  });

  it('says what differs, what NetSuite posts that the rule doesn\'t, and what NetSuite left out', () => {
    const c = bill(LINES, [ns('0', '200', -66000), ns('1', '530', 55000), ns('2', '110', 12000), ns('9', '480', -1000)]);
    expect(reasons(c)).toEqual([
      { key: 'amount|200', text: "What's owed in 2000 Accounts Payable differs from what NetSuite posted there." },
      { key: 'amount|530', text: 'What FleetSuite posts to 5300 Subcontractors differs from what NetSuite posted there.' },
      { key: 'swap|item|610|110', text: 'Items: FleetSuite used 6100 Shop Supplies, NetSuite 1100 Undeposited Funds.' },
      { key: 'none|VendBill|205', text: 'NetSuite posted nothing to 2050 Received Not Billed for the bill.' },
      { key: 'other|480', text: 'NetSuite also posts to 4800 Vendor Discounts, which the bill rule doesn\'t.' },
    ]);
  });

  it('gives the rule\'s problems in words, and nothing for a match or a wait', () => {
    expect(reasons(bill())).toEqual([]);
    expect(reasons(bill(null))).toEqual([]);
    const c = bill([
      line('1', '999', 100), { ...expense('2', null, 100), tax: true }, expense('3', null, 100), line('4', '901', null),
    ], POSTED, null, 65000, { ...CTX, accounts: { ...ACCOUNTS, payables: null } });
    expect(reasons(c, 'VendCred').map((r) => r.text)).toEqual([
      "Item 999 isn't in the copy of NetSuite's items yet. Sync now on the NetSuite lists page copies it.",
      "The bill credit has a tax line, which the bill rule doesn't post yet.",
      "An expense line on the bill credit has no account: NetSuite didn't say which account it goes to.",
      "A line's amount couldn't be read from the copy of the bill credit.",
    ]);
    const stock = bill([line('1', '901', 64900), expense('2', '530', 100)], POSTED, null, 65000, { ...CTX, accounts: { ...ACCOUNTS, payables: null } });
    expect(reasons(stock).map((r) => r.text)).toEqual([
      "FleetSuite can't tell whether the bill came from a purchase order: what it's linked to hasn't been copied from NetSuite yet.",
      'The chart of accounts has no payables account this company can use.',
    ]);
    const noAccount = bill([line('1', '901', 65000)], POSTED, false, 65000, {
      ...CTX, accounts: { ...ACCOUNTS, items: new Map([['901', { ...ITEMS.get('901')!, assetAccount: null }]]) },
    });
    expect(reasons(noAccount).map((r) => r.text)).toEqual(["WIDGET-1 has no asset account in the copy of NetSuite's items."]);
  });
});

// ── A month ────────────────────────────────────────────────────────────────

type MonthBill = BillMonthData['bills'][number];
const gl = (...lines: Array<[string, string, number]>) => lines.map(([lineId, acct, cents]) => ({
  line_id: lineId, account: acct, debit: cents > 0 ? (cents / 100).toFixed(2) : '0.00', credit: cents < 0 ? (-cents / 100).toFixed(2) : '0.00',
}));
const copied = (lineId: string, item: string | null, acct: string | null, amount: string, fields: Partial<NonNullable<MonthBill['lines']>[number]> = {}) => ({
  line_id: lineId, item, account: acct, amount, quantity: null, memo: null, tax: false, ...fields,
});
const monthBill = (fields: Partial<MonthBill>): MonthBill => ({
  netsuite_id: '701', type: 'VendBill', number: 'B-701', date: '2026-09-08', posting_month: '2026-09-01', total: '650.00', voided: false,
  status: 'Open', vendor: 'Sample Supply Co', vendor_netsuite_id: '50', vendor_payables: null, companies: ['BMG'],
  // NetSuite signs these bills' lines the other way round from the GL; the check turns them.
  lines: [copied('1', null, '530', '-500.00'), copied('2', '902', null, '-120.00', { quantity: '-4', memo: 'Gloves' }), copied('3', '901', null, '-30.00')],
  links: [{ netsuite_id: '601', type: 'PurchOrd', number: 'PO601', amount: '650.00' }, { netsuite_id: '611', type: 'ItemRcpt', number: null, amount: null }],
  netsuite: gl(['0', '200', -65000], ['1', '530', 50000], ['2', '610', 12000], ['3', '205', 3000]),
  ...fields,
});
const MONTH: BillMonthData = {
  bills: [
    monthBill({}),
    // A bill credit for supplies sent back.
    monthBill({
      netsuite_id: '702', type: 'VendCred', number: 'VC-702', date: '2026-09-12', total: '120.00', status: null,
      lines: [copied('1', '902', null, '120.00', { quantity: '4' })], links: [],
      netsuite: gl(['0', '200', 12000], ['1', '610', -12000]),
    }),
    // Dated in August, booked by NetSuite into September, to the vendor's own payables account, which BMG's chart has as inactive.
    monthBill({
      netsuite_id: '703', number: 'B-703', date: '2026-08-30', posting_month: '2026-09-01', total: '50.00', vendor_payables: '201',
      lines: [copied('1', null, '530', '-50.00')], links: [], netsuite: gl(['0', '200', -5000], ['1', '530', 5000]),
    }),
    // Its lines not copied yet.
    monthBill({ netsuite_id: '704', number: 'B-704', lines: null, links: null, netsuite: gl(['0', '200', -1000], ['1', '530', 1000]) }),
    // In neither company's GL copy: a bill waiting for approval, say.
    monthBill({ netsuite_id: '705', number: 'B-705', companies: [], netsuite: [] }),
  ],
  items: [
    { netsuite_id: '901', name: 'WIDGET-1', item_type: 'InvtPart', asset_account: '130', expense_account: null, income_account: null },
    { netsuite_id: '902', name: 'SUPPLY-2', item_type: 'NonInvtPart', asset_account: null, expense_account: '610', income_account: null },
  ],
  receipt_accounts: [{ account: '205', documents: 30 }, { account: '206', documents: 2 }],
  not_copied: [{ netsuite_id: '709', type: 'VendBill', number: 'B-709' }],
};

describe('checkBillMonth', () => {
  it('checks every bill and bill credit of the company\'s, with its lines, what it came from, and why any don\'t match', () => {
    const m = checkBillMonth(MONTH, { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 4, matches: 3, differs: 0, unworkable: 0, waiting: 1, withCost: 0 });
    expect(m.invoices.map((b) => [b.number, b.type, b.status, b.waiting, b.customer, b.total])).toEqual([
      ['B-701', 'VendBill', 'matches', undefined, 'Sample Supply Co', 65000],
      ['VC-702', 'VendCred', 'matches', undefined, 'Sample Supply Co', 12000],
      ['B-703', 'VendBill', 'matches', undefined, 'Sample Supply Co', 5000],
      ['B-704', 'VendBill', 'waiting', 'lines', 'Sample Supply Co', 65000],
    ]);
    const [b701, vc702, b703] = m.invoices;
    expect(b701).toMatchObject({
      netsuiteStatus: 'Open',
      from: ['PO601', 'NetSuite item receipt 611'],
      lines: [
        { label: 'Expense to 5300 Subcontractors', quantity: null, memo: null, cents: 50000 },
        { label: 'SUPPLY-2', quantity: '-4', memo: 'Gloves', cents: 12000 },
        { label: 'WIDGET-1', quantity: null, memo: null, cents: 3000 },
      ],
    });
    expect(b701.rows.map((r) => [r.label, r.fleetsuite?.account, r.same])).toEqual([
      ['Payables', '200', true], ['Expense', '530', true], ['Items', '610', true], ['Received stock', '205', true],
    ]);
    // A bill credit's lines show as the document has them.
    expect(vc702).toMatchObject({ from: [], lines: [{ label: 'SUPPLY-2', quantity: '4', memo: null, cents: 12000 }] });
    expect(vc702.netsuiteStatus).toBeUndefined();
    expect(b703.booked).toEqual({ month: '2026-09-01', date: '2026-09-01' });
    expect(m.reasons).toEqual([]);
    expect(m.accounts).toEqual({
      200: '2000 Accounts Payable', 205: '2050 Received Not Billed', 530: '5300 Subcontractors', 610: '6100 Shop Supplies',
    });
    expect(m.notes).toEqual([
      "NetSuite's item receipts for BMG credit 2 accounts, so FleetSuite takes received stock off 2050 Received Not Billed, the one most of them credit.",
      '1 bill or bill credit dated in another month is here because NetSuite booked it into this month: B-703.',
      "1 more bill or bill credit dated this month isn't in the copy of NetSuite's GL for either company: B-705. NetSuite may not have "
        + "posted it (a bill waiting for approval doesn't post), or the copy, which runs every two hours, hasn't reached it yet.",
      "The copy of NetSuite's GL has 1 bill or bill credit of this company's booked into this month that the copy of the bills doesn't: "
        + 'B-709. The bills copy runs every two hours and may not have reached it yet, or NetSuite deleted it and the GL copy hasn\'t caught up.',
    ]);
  });

  it('says what FleetSuite\'s books hold for each of the company\'s and what the next run does, when its bills post', () => {
    const asked: string[] = [];
    const books = (w: WorkedBill): InvoiceBooks => {
      asked.push(w.number);
      if (w.number === 'B-701') return { entryNo: 12, next: null, earlier: [{ entryNo: 9, reversedBy: 11 }] };
      return { entryNo: null, next: w.checked.status === 'waiting' ? null : 'post', earlier: [] };
    };
    const m = checkBillMonth(MONTH, { company: 'BMG', chart: CHART }, books);
    // Not B-705, which neither company's GL copy has.
    expect(asked).toEqual(['B-701', 'VC-702', 'B-703', 'B-704']);
    expect(m.invoices.map((b) => [b.number, b.books?.entryNo, b.books?.next])).toEqual([
      ['B-701', 12, null], ['VC-702', null, 'post'], ['B-703', null, 'post'], ['B-704', null, null],
    ]);
    expect(m.invoices[0].books?.earlier).toEqual([{ entryNo: 9, reversedBy: 11 }]);
    expect(m.summary).toMatchObject({ posted: 1, pending: 2 });
    // A company whose bills don't post yet gets neither.
    const without = checkBillMonth(MONTH, { company: 'BMG', chart: CHART });
    expect(without.invoices.map((b) => b.books)).toEqual([undefined, undefined, undefined, undefined]);
    expect([without.summary.posted, without.summary.pending]).toEqual([undefined, undefined]);
  });

  it('uses the vendor\'s own payables account when the company can use it', () => {
    const chart = CHART.map((a) => (a.netsuite_account_id === '201' ? { ...a, active: true } : a));
    const m = checkBillMonth(MONTH, { company: 'BMG', chart });
    const b703 = m.invoices.find((b) => b.number === 'B-703')!;
    expect(b703.status).toBe('differs');
    expect(b703.reasons).toEqual(['Payables: FleetSuite used 2010 Payables Other, NetSuite 2000 Accounts Payable.']);
    expect(m.reasons.map((r) => [r.invoices, r.examples])).toEqual([[1, ['B-703']]]);
    // Two payables accounts now: the others go to the one the month's bills used most.
    expect(m.notes[0]).toBe(
      "BMG can use 2 payables accounts, so for a vendor with none of its own FleetSuite used 2000 Accounts Payable, the one NetSuite's bills used most this month.",
    );
  });

  it('puts stock bought on the bill itself in its asset account, and can\'t tell where it goes before the links are copied', () => {
    const bought = workOutBillMonth({ ...MONTH, bills: [monthBill({ links: [] })] }, { company: 'BMG', chart: CHART });
    expect(bought.bills[0].checked.rows.find((r) => r.role === 'stock')?.fleetsuite).toEqual({ account: '130', cents: 3000 });
    const m = checkBillMonth({ ...MONTH, bills: [monthBill({ links: null })] }, { company: 'BMG', chart: CHART });
    expect(m.invoices[0]).toMatchObject({
      status: 'unworkable',
      from: [],
      reasons: ["FleetSuite can't tell whether the bill came from a purchase order: what it's linked to hasn't been copied from NetSuite yet."],
    });
  });

  // A $92.00 bill from a purchase order: $100.00 of stock, a subtotal, and 8% off it, NetSuite's net amounts sharing the discount out.
  const DISC = { netsuite_id: '904', name: 'DISC', item_type: 'Discount', asset_account: null, expense_account: null, income_account: '480' };
  const ownAmountsNote = (n: string) => n.startsWith("NetSuite's own amounts");
  const discounted = monthBill({
    netsuite_id: '710', number: 'B-710', total: '92.00',
    lines: [
      copied('1', '901', null, '-92.00', { own_amount: '-100.00', quantity: '-1' }),
      copied('2', '-2', null, '-100.00', { own_amount: '-100.00' }),
      copied('3', '904', null, '0.00', { own_amount: '8.00' }),
    ],
    links: [{ netsuite_id: '601', type: 'PurchOrd', number: 'PO601', amount: '92.00' }],
    netsuite: gl(['0', '200', -9200], ['1', '205', 10000], ['3', '480', -800]),
  });

  it('matches a discount on a bill at the lines\' own amounts, the discount a credit of its own', () => {
    const m = checkBillMonth({ ...MONTH, bills: [discounted], items: [...MONTH.items, DISC] }, { company: 'BMG', chart: CHART });
    expect(m.invoices[0]).toMatchObject({
      status: 'matches',
      amounts: 'own',
      reasons: [],
      lines: [
        { label: 'WIDGET-1', quantity: '-1', cents: 10000 },
        { label: 'Subtotal', quantity: null, cents: 10000 },
        { label: 'DISC', quantity: null, cents: -800 },
      ],
    });
    expect(m.notes.filter(ownAmountsNote)).toEqual([]);
    expect(m.invoices[0].rows.map((r) => [r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.same])).toEqual([
      ['Payables', '200', -9200, true], ['Received stock', '205', 10000, true], ['Items', '480', -800, true],
    ]);
    // Copied before the copy kept the own amounts: the net ones share the discount out, and the check says how it differs.
    const old = { ...discounted, lines: discounted.lines!.map(({ own_amount: _o, ...l }) => l) };
    const before = checkBillMonth({ ...MONTH, bills: [old], items: [...MONTH.items, DISC] }, { company: 'BMG', chart: CHART });
    expect(before.invoices[0]).toMatchObject({
      status: 'differs',
      reasons: [
        'What FleetSuite posts to 2050 Received Not Billed differs from what NetSuite posted there.',
        "NetSuite also posts to 4800 Vendor Discounts, which the bill rule doesn't.",
      ],
    });
    expect(before.invoices[0]).not.toHaveProperty('amounts');
    expect(before.notes.filter(ownAmountsNote)).toEqual([]);
  });

  it('says when a document\'s lines don\'t add up at their own amounts, and uses the net ones', () => {
    const unfit = { ...discounted, lines: discounted.lines!.map((l) => (l.line_id === '3' ? { ...l, own_amount: '5.00' } : l)) };
    const m = checkBillMonth({ ...MONTH, bills: [unfit], items: [...MONTH.items, DISC] }, { company: 'BMG', chart: CHART });
    expect(m.invoices[0]).toMatchObject({ status: 'differs', amounts: 'unfit' });
    expect(m.invoices[0].lines.map((l) => l.cents)).toEqual([9200, 10000, 0]);
    expect(m.notes.filter(ownAmountsNote)).toEqual([
      "NetSuite's own amounts for the lines of 1 bill or bill credit don't add up to it, so FleetSuite took its lines at their net amounts, "
        + 'with any discount shared out over them: B-710.',
    ]);
    // Whether it matches or not; a document NetSuite booked into neither company's GL isn't named.
    const plain = (fields: Partial<MonthBill>) => monthBill({ lines: MONTH.bills[0].lines!.map((l) => ({ ...l, own_amount: '1.00' })), ...fields });
    const two = checkBillMonth({
      ...MONTH, bills: [plain({}), plain({ netsuite_id: '713', number: 'B-713' }), plain({ netsuite_id: '714', number: 'B-714', companies: [], netsuite: [] })],
    }, { company: 'BMG', chart: CHART });
    expect(two.invoices.map((b) => [b.number, b.status, b.amounts])).toEqual([['B-701', 'matches', 'unfit'], ['B-713', 'matches', 'unfit']]);
    expect(two.notes.filter(ownAmountsNote)).toEqual([
      "NetSuite's own amounts for the lines of 2 bills and bill credits don't add up to them, so FleetSuite took their lines at their net amounts, "
        + 'with any discount shared out over them: B-701, B-713.',
    ]);
  });

  it('puts an item the copy of NetSuite\'s items has no account for where NetSuite posted most of its bill lines', () => {
    const items = [...MONTH.items, { ...DISC, income_account: null }];
    expect(itemsWithoutAccount(items)).toEqual(['904']);
    const worked = (item_accounts?: BillMonthData['item_accounts']) =>
      workOutBillMonth({ ...MONTH, bills: [discounted], items, item_accounts }, { company: 'BMG', chart: CHART }).bills[0].checked;
    expect(worked([{ item: '904', account: '530', lines: 1 }, { item: '904', account: '480', lines: 6 }]).status).toBe('matches');
    // The lower NetSuite id on a tie.
    const tie = worked([{ item: '904', account: '481', lines: 2 }, { item: '904', account: '480', lines: 2 }]);
    expect(tie.rows.find((r) => r.role === 'item')?.fleetsuite).toEqual({ account: '480', cents: -800 });
    expect(worked([{ item: '904', account: '480', lines: 2 }, { item: '904', account: '481', lines: 3 }]).rows.find((r) => r.role === 'item')?.fleetsuite)
      .toEqual({ account: '481', cents: -800 });
    // Nowhere to go by: it can't be worked out, and says why.
    expect(worked([{ item: '905', account: '480', lines: 9 }]).status).toBe('unworkable');
    expect(checkBillMonth({ ...MONTH, bills: [discounted], items }, { company: 'BMG', chart: CHART }).invoices[0]).toMatchObject({
      status: 'unworkable',
      reasons: ["DISC has no expense account in the copy of NetSuite's items, and no copied bill shows where NetSuite posts it."],
    });
  });

  it('asks only about the non-stock items the copy has no account for', () => {
    expect(itemsWithoutAccount([
      ...MONTH.items,
      { ...DISC, netsuite_id: '905' },
      { netsuite_id: '906', name: 'ASSY-6', item_type: 'Assembly', asset_account: null, expense_account: null, income_account: null },
      { netsuite_id: '907', name: 'SUB', item_type: 'Subtotal', asset_account: null, expense_account: null, income_account: null },
      { netsuite_id: '-2', name: 'Subtotal', item_type: null, asset_account: null, expense_account: null, income_account: null },
      { netsuite_id: '908', name: 'SVC', item_type: 'Service', asset_account: null, expense_account: null, income_account: '400' },
      { netsuite_id: '909', name: 'MARKUP', item_type: 'Markup', asset_account: null, expense_account: null, income_account: null },
    ])).toEqual(['908', '909']);
  });

  it('decides received stock line by line: a line added on a purchase order\'s bill brings its stock in on the bill', () => {
    // $300.00 of stock from PO601's line, and $30.00 more added on the bill itself.
    const added = monthBill({
      netsuite_id: '711', number: 'B-711', total: '330.00',
      lines: [copied('1', '901', null, '-300.00'), copied('2', '901', null, '-30.00')],
      links: [{ netsuite_id: '601', type: 'PurchOrd', number: 'PO601', amount: '300.00', lines: ['1'] }],
      netsuite: gl(['0', '200', -33000], ['1', '205', 30000], ['2', '130', 3000]),
    });
    const m = checkBillMonth({ ...MONTH, bills: [added] }, { company: 'BMG', chart: CHART });
    expect(m.invoices[0].status).toBe('matches');
    expect(m.invoices[0].rows.map((r) => [r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.same])).toEqual([
      ['Payables', '200', -33000, true], ['Received stock', '205', 30000, true], ['Inventory', '130', 3000, true],
    ]);
    // A receipt's lines count as the order's, and every order's and receipt's lines count.
    const received = { ...added, links: [{ netsuite_id: '611', type: 'ItemRcpt', number: 'IR611', amount: '300.00', lines: ['1'] }] };
    expect(checkBillMonth({ ...MONTH, bills: [received] }, { company: 'BMG', chart: CHART }).invoices[0].status).toBe('matches');
    const both = {
      ...added,
      links: [
        { netsuite_id: '601', type: 'PurchOrd', number: 'PO601', amount: '300.00', lines: ['1'] },
        { netsuite_id: '611', type: 'ItemRcpt', number: 'IR611', amount: '30.00', lines: ['2'] },
      ],
      netsuite: gl(['0', '200', -33000], ['1', '205', 33000]),
    };
    expect(checkBillMonth({ ...MONTH, bills: [both] }, { company: 'BMG', chart: CHART }).invoices[0].status).toBe('matches');
    // A link that isn't an order or a receipt makes nothing ordered, whatever lines it's on: here a bill credit's to the bill it credits.
    const credit = monthBill({
      netsuite_id: '712', type: 'VendCred', number: 'VC-712', total: '30.00',
      lines: [copied('1', '901', null, '30.00')],
      links: [{ netsuite_id: '701', type: 'VendBill', number: 'B-701', amount: '30.00', lines: ['1'] }],
      netsuite: gl(['0', '200', 3000], ['1', '130', -3000]),
    });
    expect(checkBillMonth({ ...MONTH, bills: [credit] }, { company: 'BMG', chart: CHART }).invoices[0]).toMatchObject({ status: 'matches', from: [] });
    // Links on none of the document's own lines (its payables line, say) say nothing line by line: it goes by the document.
    const header = { ...added, links: [{ netsuite_id: '601', type: 'PurchOrd', number: 'PO601', amount: '330.00', lines: ['0'] }] };
    const byDocument = workOutBillMonth({ ...MONTH, bills: [header] }, { company: 'BMG', chart: CHART }).bills[0];
    expect(byDocument.lines?.map((l) => l.ordered)).toEqual([null, null]);
    expect(byDocument.checked.rows.map((r) => [r.role, r.fleetsuite?.account, r.fleetsuite?.cents])).toEqual([
      ['payables', '200', -33000], ['received', '205', 33000], ['other', undefined, undefined],
    ]);
  });

  it('puts ordered stock in its asset account when no item receipt holds received stock, and says why', () => {
    const { bills, notes } = workOutBillMonth({ ...MONTH, receipt_accounts: [] }, { company: 'BMG', chart: CHART });
    expect(bills[0].checked.rows.find((r) => r.role === 'stock')?.fleetsuite).toEqual({ account: '130', cents: 3000 });
    expect(bills[0].lines?.map((l) => l.cents)).toEqual([50000, 12000, 3000]);
    expect(notes).toContain(
      "The copy of NetSuite's GL has no item receipt of BMG's that holds received stock in an account until it's billed, so stock on bills "
        + "from purchase orders goes to the items' asset accounts.",
    );
  });
});
