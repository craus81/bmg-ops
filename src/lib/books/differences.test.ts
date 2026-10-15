import { describe, it, expect } from 'vitest';
import {
  accountNamer, compareMonth, copyHolds, COST, explainDocument, indexMonths, kindName, kindOf, kindRows, lastMonth, monthStatuses,
  monthText, postedKinds, type DiffData, type DiffDocumentData,
} from './differences';

const SEP = '2026-09-01';

/** NetSuite's invoice and bill in September, and FleetSuite's entry for the invoice. */
const data = (fleetsuiteSales = '-100.00'): DiffData => ({
  netsuite: [
    { month: SEP, account: '120', kind: 'CustInvc', net: '100.00' },
    { month: SEP, account: '400', kind: 'CustInvc', net: '-100.00' },
    { month: SEP, account: '600', kind: 'VendBill', net: '30.00' },
    { month: SEP, account: '200', kind: 'VendBill', net: '-30.00' },
  ],
  fleetsuite: [
    { month: SEP, account: '120', kind: 'invoice', net: '100.00' },
    { month: SEP, account: '400', kind: 'invoice', net: fleetsuiteSales },
    ...(fleetsuiteSales === '-100.00' ? [] : [{ month: SEP, account: '410', kind: 'invoice', net: (-100 - Number(fleetsuiteSales)).toFixed(2) }]),
  ],
  netsuite_kinds: [
    { month: SEP, kind: 'CustInvc', documents: 1, moved: '100.00' },
    { month: SEP, kind: 'VendBill', documents: 1, moved: '30.00' },
  ],
  fleetsuite_kinds: [{ month: SEP, kind: 'invoice', documents: 1, moved: '100.00' }],
});

describe('kinds', () => {
  it('compares FleetSuite\'s documents under the NetSuite type they copy, and its own kinds apart', () => {
    expect(kindOf('invoice')).toBe('CustInvc');
    expect(kindOf('payment')).toBe('CustPymt');
    expect(kindOf('opening_balance')).toBe('fleetsuite:opening_balance');
    expect(kindName('CustCred')).toBe('Credit Memo');
    expect(kindName('ItemShip')).toBe('Item Fulfillment');
    expect(kindName('SomethingNew')).toBe('SomethingNew');
    expect(kindName(COST)).toBe('Cost of goods on invoices');
    expect(kindName('fleetsuite:opening_balance')).toBe('Opening balance (FleetSuite only)');
    expect(kindName('fleetsuite:vendor_bill')).toBe('Vendor bill (FleetSuite only)');
  });

  it('takes a company as posting what its rules post, or what it holds entries of', () => {
    expect([...postedKinds(data(), true)].sort()).toEqual(['CustCred', 'CustInvc', 'CustPymt']);
    expect([...postedKinds(data(), false)]).toEqual(['CustInvc']);
    expect([...postedKinds({ ...data(), fleetsuite: [] }, false)]).toEqual([]);
  });
});

describe('compareMonth', () => {
  it('matches when what FleetSuite posts comes to NetSuite\'s, with the rest not posted yet', () => {
    const d = data();
    const cmp = compareMonth(indexMonths(d).get(SEP), SEP, postedKinds(d, true));
    expect(cmp.status).toBe('matches');
    expect(cmp.differing).toBe(0);
    expect(cmp.covered).toBeCloseTo(100 / 130);
    expect(cmp.accounts.find((a) => a.account === '600')).toEqual({ account: '600', fleetsuite: 0, netsuite: 3000, notPosted: 3000, differs: 0 });
    expect(cmp.accounts.find((a) => a.account === '400')).toEqual({ account: '400', fleetsuite: -10000, netsuite: -10000, notPosted: 0, differs: 0 });
  });

  it('differs on the accounts where FleetSuite posted otherwise', () => {
    const d = data('-90.00');
    const cmp = compareMonth(indexMonths(d).get(SEP), SEP, postedKinds(d, true));
    expect(cmp.status).toBe('differs');
    expect(cmp.accounts.filter((a) => a.differs).map((a) => [a.account, a.differs])).toEqual([['400', 1000], ['410', -1000]]);
  });

  it('says none for a month with nothing FleetSuite posts, and for an empty month', () => {
    const d = data();
    const notPosting = { ...d, fleetsuite: [], fleetsuite_kinds: [] };
    expect(compareMonth(indexMonths(notPosting).get(SEP), SEP, postedKinds(notPosting, false)).status).toBe('none');
    expect(compareMonth(undefined, '2026-08-01', postedKinds(d, true))).toEqual({
      month: '2026-08-01', status: 'none', differing: 0, covered: null, accounts: [], kinds: [],
    });
  });

  it('counts a FleetSuite entry NetSuite has no kind for as a difference', () => {
    const d = data();
    d.fleetsuite.push({ month: SEP, account: '600', kind: 'manual', net: '5.00' }, { month: SEP, account: '110', kind: 'manual', net: '-5.00' });
    d.fleetsuite_kinds.push({ month: SEP, kind: 'manual', documents: 1, moved: '5.00' });
    const cmp = compareMonth(indexMonths(d).get(SEP), SEP, postedKinds(d, true));
    expect(cmp.differing).toBe(2);
    expect(kindRows(cmp, { invoice: 0 }).map((k) => [k.name, k.state, k.differing])).toEqual([
      ['Invoice', 'posted', 0],
      ['Bill', 'not_posted', null],
      ['Typed entry (FleetSuite only)', 'fleetsuite_only', null],
    ]);
  });

  it('shows no count of differing documents when they weren\'t asked for', () => {
    const d = data();
    const cmp = compareMonth(indexMonths(d).get(SEP), SEP, postedKinds(d, true));
    expect(kindRows(cmp, null).map((k) => k.differing)).toEqual([null, null]);
  });
});

describe('months', () => {
  it('runs from January 2025 to the latest month either side has, never before the floor', () => {
    expect(lastMonth(data(), '2026-10-01')).toBe('2026-10-01');
    expect(lastMonth(data(), '2026-08-01')).toBe(SEP);
    const d = data('-90.00');
    const months = monthStatuses(indexMonths(d), postedKinds(d, true), '2026-10-01');
    expect(months).toHaveLength(22);
    expect(months[0]).toEqual({ month: '2025-01-01', status: 'none', differing: 0, covered: null });
    expect(months.find((m) => m.month === SEP)).toMatchObject({ status: 'differs', differing: 2 });
    expect(monthText('2026-09-01')).toBe('September 2026');
  });
});

describe('copyHolds', () => {
  it('says whether the copy holds what NetSuite\'s own totals say the month moved', () => {
    const totals = {
      netsuite: [
        { netsuite_account_id: '120', month: SEP, debit: '100.00', credit: '0' },
        { netsuite_account_id: '400', month: SEP, debit: '0', credit: '100.00' },
        { netsuite_account_id: '120', month: '2026-10-01', debit: '50.00', credit: '0' },
      ],
      copied: [
        { netsuite_account_id: '120', month: SEP, debit: '100.00', credit: '0' },
        { netsuite_account_id: '400', month: SEP, debit: '0', credit: '100.00' },
      ],
    };
    expect(copyHolds(totals, SEP)).toBe(true);
    expect(copyHolds(totals, '2026-10-01')).toBe(false);
    expect(copyHolds(totals, '2026-11-01')).toBe(true);
    expect(copyHolds({ netsuite: [], copied: [] }, SEP)).toBeNull();
    expect(copyHolds(null, SEP)).toBeNull();
  });
});

describe('accountNamer', () => {
  it('names NetSuite accounts and FleetSuite-only ones from the chart', () => {
    const name = accountNamer([
      { id: 'a1', netsuite_account_id: '120', number: '1200', name: 'Receivables' },
      { id: 'a2', netsuite_account_id: null, number: null, name: 'FleetSuite Clearing' },
    ]);
    expect(name('120')).toEqual({ number: '1200', name: 'Receivables', inChart: true });
    expect(name('fs:a2')).toEqual({ number: null, name: 'FleetSuite Clearing', inChart: true });
    expect(name('999')).toEqual({ number: null, name: 'NetSuite account 999', inChart: false });
    expect(name('fs:gone')).toEqual({ number: null, name: 'FleetSuite account no longer in the chart', inChart: false });
  });
});

describe('explainDocument', () => {
  const ctx = {
    name: accountNamer([
      { id: 'a1', netsuite_account_id: '120', number: '1200', name: 'Receivables' },
      { id: 'a2', netsuite_account_id: '400', number: '4000', name: 'Sales' },
      { id: 'a3', netsuite_account_id: '500', number: '5000', name: 'Cost of Goods Sold' },
      { id: 'a4', netsuite_account_id: '130', number: '1300', name: 'Inventory' },
    ]),
    costAccounts: new Set(['500', '130']),
  };
  const doc = (over: Partial<DiffDocumentData>): DiffDocumentData => ({
    kind: 'invoice',
    netsuite_id: '77',
    lines: [{ account: '120', netsuite: '10.00', fleetsuite: '0' }, { account: '400', netsuite: '-10.00', fleetsuite: '0' }],
    netsuite: { type: 'CustInvc', number: 'INV77', date: '2026-09-03', month: SEP },
    fleetsuite: { entries: 1, standing: { entry_no: 5, date: '2026-09-03' } },
    copy: { number: 'INV77', customer: 'A Customer', voided: false, deleted: false },
    ...over,
  });

  it('puts a cost of goods difference down to the fulfillments FleetSuite posts it with', () => {
    const d = explainDocument(doc({
      lines: [{ account: '500', netsuite: '4.00', fleetsuite: '0' }, { account: '130', netsuite: '-4.00', fleetsuite: '0' }],
    }), ctx);
    expect(d).toMatchObject({ reason: 'cost', number: 'INV77', customer: 'A Customer', entryNo: 5, netsuite: 400, fleetsuite: 0 });
    expect(d.lines.map((l) => l.number)).toEqual(['1300', '5000']);
  });

  it('names the first two accounts that differ and counts the rest', () => {
    const d = explainDocument(doc({
      lines: [
        { account: '120', netsuite: '10.00', fleetsuite: '12.00' },
        { account: '400', netsuite: '-10.00', fleetsuite: '-8.00' },
        { account: '500', netsuite: '0', fleetsuite: '1.00' },
        { account: '130', netsuite: '0', fleetsuite: '-5.00' },
      ],
    }), ctx);
    expect(d.reason).toBe('amounts');
    expect(d.why).toBe('Posted differently on 4 accounts: 1200 Receivables: FleetSuite $12.00, NetSuite $10.00; 1300 Inventory: FleetSuite -$5.00, NetSuite $0.00; 2 more.');
  });

  it('says when NetSuite voided it or its ledger has no lines of it while FleetSuite\'s entry stands', () => {
    expect(explainDocument(doc({ netsuite: null, copy: { number: 'INV77', customer: null, voided: true, deleted: false } }), ctx).why)
      .toBe("Voided in NetSuite, which posts nothing for it now. The next posting run reverses FleetSuite's entry.");
    expect(explainDocument(doc({ netsuite: null, copy: null }), ctx)).toMatchObject({
      reason: 'gone', number: 'NetSuite 77', why: "The copy of NetSuite's ledger has no lines of it, but FleetSuite's entry stands.",
    });
  });

  it('says FleetSuite doesn\'t post a payment dated before its books start, but posts an invoice like it in NetSuite\'s month', () => {
    const early = { type: 'CustPymt', number: 'PYMT9', date: '2024-12-30', month: '2025-01-01' };
    const payment = explainDocument(doc({ kind: 'payment', netsuite: early, fleetsuite: { entries: 0, standing: null } }), ctx);
    expect(payment).toMatchObject({ reason: 'before_start', listMonth: null });
    expect(payment.why).toBe("Dated Dec 30, 2024, before FleetSuite's books start on January 1, 2025, so FleetSuite doesn't post it. NetSuite posted it to January 2025.");
    const invoice = explainDocument(doc({ netsuite: { ...early, type: 'CustInvc' }, fleetsuite: { entries: 0, standing: null } }), ctx);
    expect(invoice).toMatchObject({ reason: 'not_posted', listMonth: '2025-01-01' });
  });

  it('links an invoice to the month NetSuite booked it into, and a payment to its own date\'s', () => {
    const late = { type: 'CustInvc', number: 'INV77', date: '2025-05-12', month: '2025-12-01' };
    expect(explainDocument(doc({ netsuite: late }), ctx)).toMatchObject({ reason: 'month', listMonth: '2025-12-01' });
    expect(explainDocument(doc({ kind: 'payment', netsuite: { ...late, type: 'CustPymt' } }), ctx).listMonth).toBe('2025-05-01');
  });

  it('dates a document FleetSuite never posted by NetSuite\'s date', () => {
    const d = explainDocument(doc({ fleetsuite: { entries: 0, standing: null } }), ctx);
    expect(d).toMatchObject({ reason: 'not_posted', date: '2026-09-03', fleetsuiteDate: null, entryNo: null, netsuite: 1000 });
    expect(d.why).toBe("FleetSuite hasn't posted it. Invoices vs NetSuite shows why.");
  });
});
