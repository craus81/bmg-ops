import { describe, it, expect } from 'vitest';
import {
  alertsFor, balanceAlertsFor, balanceKey, lookOf, nextCheck, parseCheckState, stockAlertsFor,
  type BalanceNews, type CompanyCheck, type DifferingMonths, type MonthFacts, type MonthNews, type StockNews,
} from './daily-check';
import type { DiffDocumentData } from './differences';
import type { StockLine } from './stock-items';
import { deepLinks } from '@/lib/deep-links';

const AUG = '2026-08-01';
const SEP = '2026-09-01';
const OCT = '2026-10-01';
const DEC = '2025-12-01';

/** A day: the first look, then the second, from what differs at each. */
function day(prev: CompanyCheck | undefined, first: DifferingMonths, second: DifferingMonths) {
  const a = nextCheck(prev, first, 'first');
  expect(a.news).toEqual([]);
  return nextCheck(a.check, second, 'second');
}

describe('lookOf', () => {
  it('takes the 09:58 UTC run for the first look and the 13:58 one for the second', () => {
    expect(lookOf(new Date('2026-10-19T09:58:00Z'))).toBe('first');
    expect(lookOf(new Date('2026-10-19T13:58:00Z'))).toBe('second');
    expect(lookOf(new Date('2026-10-19T11:59:59Z'))).toBe('first');
    expect(lookOf(new Date('2026-10-19T12:00:00Z'))).toBe('second');
  });
});

describe('parseCheckState', () => {
  it('reads what the last look recorded, company by company', () => {
    const state = parseCheckState({
      look: 'second',
      told: 1,
      companies: { BMG: { known: { [DEC]: 1, [SEP]: 2 }, noted: {} }, 1084: { known: {}, noted: { [OCT]: 0 } } },
    });
    expect(state).toEqual({ companies: { BMG: { known: { [DEC]: 1, [SEP]: 2 }, noted: {} }, 1084: { known: {}, noted: { [OCT]: 0 } } } });
  });

  it('reads what it holds for stock by item, keyed by item and location, or by item when NetSuite counts company-wide', () => {
    const stock = { by: 'location', known: { '9001|11': 2, '9002|': 1 }, noted: { '9003|12': 1 } };
    expect(parseCheckState({ companies: {}, stock })).toEqual({ companies: {}, stock });
    expect(parseCheckState({ companies: {}, stock: { by: 'item', known: { 9001: 1 }, noted: {} } }).stock)
      .toEqual({ by: 'item', known: { 9001: 1 }, noted: {} });
  });

  it("looks at stock afresh when its part doesn't read", () => {
    for (const stock of [
      null, 'x', { known: {}, noted: {} }, { by: 'shelf', known: {}, noted: {} },
      { by: 'location', known: { 'LDR-24|11': 1 }, noted: {} }, { by: 'location', known: { '9001|11': 0.5 }, noted: {} },
      { by: 'location', known: {}, noted: [] },
    ]) {
      expect(parseCheckState({ companies: {}, stock })).toEqual({ companies: {} });
    }
  });

  it("reads what it holds for each company's balances, keyed by customer or vendor, and drops a part that doesn't read", () => {
    const acme = 'c0000000-0000-4000-8000-00000000000a';
    const balances = { BMG: { known: { [`c:${acme}`]: 2, 'c:': 1, 'v:7001': 1, 'v:': 3 }, noted: { 'v:7002': 1 } }, 1084: { known: {}, noted: {} } };
    expect(parseCheckState({ companies: {}, balances })).toEqual({ companies: {}, balances });
    expect(parseCheckState({ companies: {}, balances: { BMG: { known: { 'c:acme': 1 }, noted: {} } } })).toEqual({ companies: {} });
    expect(parseCheckState({ companies: {}, balances: { BMG: { known: { 'x:7001': 1 }, noted: {} }, 1084: balances[1084] } }))
      .toEqual({ companies: {}, balances: { 1084: { known: {}, noted: {} } } });
    expect(parseCheckState({ companies: {}, balances: 'x' })).toEqual({ companies: {} });
    expect(balanceKey('customer', acme)).toBe(`c:${acme}`);
    expect(balanceKey('vendor', '')).toBe('v:');
  });

  it("drops a company whose part doesn't read, so it's looked at afresh, and a company that doesn't post", () => {
    expect(parseCheckState(null)).toEqual({ companies: {} });
    expect(parseCheckState({ companies: 'x' })).toEqual({ companies: {} });
    const state = parseCheckState({
      companies: {
        BMG: { known: { '2026-09-15': 1 }, noted: {} },
        1084: { known: { [SEP]: -1 }, noted: {} },
        ACME: { known: {}, noted: {} },
      },
    });
    expect(state).toEqual({ companies: {} });
    expect(parseCheckState({ companies: { BMG: { known: { [SEP]: 1.5 }, noted: {} } } })).toEqual({ companies: {} });
    expect(parseCheckState({ companies: { BMG: { known: { [SEP]: 1 } } } })).toEqual({ companies: {} });
  });
});

describe('nextCheck', () => {
  it('takes what differs at its first look as known and tells nothing, whichever look that is', () => {
    expect(nextCheck(undefined, { [DEC]: 1 }, 'first')).toEqual({ check: { known: { [DEC]: 1 }, noted: {} }, news: [] });
    expect(nextCheck(undefined, { [DEC]: 1 }, 'second')).toEqual({ check: { known: { [DEC]: 1 }, noted: {} }, news: [] });
  });

  it('notes a month that stopped matching at the first look and tells about it at the second while it still differs', () => {
    const start: CompanyCheck = { known: { [DEC]: 1 }, noted: {} };
    const first = nextCheck(start, { [DEC]: 1, [SEP]: 2 }, 'first');
    expect(first).toEqual({ check: { known: { [DEC]: 1 }, noted: { [SEP]: 2 } }, news: [] });
    const second = nextCheck(first.check, { [DEC]: 1, [SEP]: 3 }, 'second');
    expect(second.news).toEqual([{ month: SEP, documents: 3, before: null }]);
    expect(second.check).toEqual({ known: { [DEC]: 1, [SEP]: 3 }, noted: {} });

    // Nothing more to tell while it stays as it is.
    expect(day(second.check, { [DEC]: 1, [SEP]: 3 }, { [DEC]: 1, [SEP]: 3 })).toEqual({ check: second.check, news: [] });
  });

  it("tells nothing about a month that matches again by the second look: a document caught between NetSuite's copies", () => {
    const start: CompanyCheck = { known: {}, noted: {} };
    expect(day(start, { [OCT]: 1 }, {})).toEqual({ check: { known: {}, noted: {} }, news: [] });
  });

  it('tells nothing about what first differs at the second look until the next morning has noted it', () => {
    const start: CompanyCheck = { known: {}, noted: {} };
    const today = day(start, {}, { [OCT]: 1 });
    expect(today).toEqual({ check: { known: {}, noted: {} }, news: [] });
    expect(day(today.check, { [OCT]: 1 }, { [OCT]: 1 }).news).toEqual([{ month: OCT, documents: 1, before: null }]);
  });

  it('tells about a month that already differed only once more of its documents differ', () => {
    const start: CompanyCheck = { known: { [DEC]: 1 }, noted: {} };
    const worse = day(start, { [DEC]: 2 }, { [DEC]: 2 });
    expect(worse.news).toEqual([{ month: DEC, documents: 2, before: 1 }]);
    expect(worse.check.known).toEqual({ [DEC]: 2 });
    // Back to as many as before by the second look: nothing.
    expect(day(start, { [DEC]: 2 }, { [DEC]: 1 }).news).toEqual([]);
  });

  it('holds a month at fewer documents once fewer differ, so one more later is told about again', () => {
    const start: CompanyCheck = { known: { [DEC]: 2 }, noted: {} };
    const better = nextCheck(start, { [DEC]: 1 }, 'first');
    expect(better.check).toEqual({ known: { [DEC]: 1 }, noted: {} });
    expect(nextCheck(better.check, { [DEC]: 2 }, 'second').news).toEqual([]);
    expect(day(better.check, { [DEC]: 2 }, { [DEC]: 2 }).news).toEqual([{ month: DEC, documents: 2, before: 1 }]);
  });

  it('lets a month that matches drop out, so if it differs again it is told about again', () => {
    const start: CompanyCheck = { known: { [SEP]: 1 }, noted: {} };
    const fixed = day(start, {}, {});
    expect(fixed.check).toEqual({ known: {}, noted: {} });
    expect(day(fixed.check, { [SEP]: 1 }, { [SEP]: 1 }).news).toEqual([{ month: SEP, documents: 1, before: null }]);
  });

  it("notes each new month, oldest first, and notes it again the next morning when the second look didn't run", () => {
    const start: CompanyCheck = { known: {}, noted: {} };
    const first = nextCheck(start, { [SEP]: 1, [AUG]: 0 }, 'first');
    expect(Object.keys(first.check.noted)).toEqual([AUG, SEP]);
    // The next first look notes it again from what's known, so the next second look tells.
    const again = nextCheck(first.check, { [SEP]: 1, [AUG]: 0 }, 'first');
    expect(again.check.noted).toEqual({ [AUG]: 0, [SEP]: 1 });
    expect(nextCheck(again.check, { [SEP]: 1, [AUG]: 0 }, 'second').news).toEqual([
      { month: AUG, documents: 0, before: null },
      { month: SEP, documents: 1, before: null },
    ]);
  });
});

/** A differing document as gl_books_difference_documents returns it. */
const doc = (number: string | null, customer: string | null, kind = 'invoice', netsuiteId = '9001'): DiffDocumentData => ({
  kind,
  netsuite_id: netsuiteId,
  lines: [],
  netsuite: number ? { type: 'CustInvc', number, date: '2026-09-10', month: SEP } : null,
  fleetsuite: { entries: 1, standing: { entry_no: 1, date: '2026-09-10' } },
  copy: customer || !number ? { number: number ? null : 'INV-COPY', customer, voided: false, deleted: false } : null,
});
const facts = (month: string, documents: DiffDocumentData[], accounts = 2) => new Map<string, MonthFacts>([[month, { documents, accounts }]]);

describe('alertsFor', () => {
  it('names the month, the company and the document, and links to that month on Differences vs NetSuite', () => {
    const news: MonthNews[] = [{ month: SEP, documents: 1, before: null }];
    expect(alertsFor('BMG', news, facts(SEP, [doc('INV2400', 'Acme Fleet')]))).toEqual([{
      title: "BMG's books: September 2026 no longer matches NetSuite",
      body: 'INV2400 (Acme Fleet) differs from what NetSuite posted. Differences vs NetSuite shows why.',
      url: '/admin/books/differences?company=BMG&month=2026-09',
    }]);
    expect(alertsFor('1084', news, facts(SEP, [doc('JE1301', null, 'journal_entry')]))[0]).toEqual({
      title: "1084's books: September 2026 no longer matches NetSuite",
      body: 'JE1301 differs from what NetSuite posted. Differences vs NetSuite shows why.',
      url: deepLinks.booksDifferences('1084', SEP),
    });
  });

  it('names the two largest documents, and how many differ when there are more', () => {
    const two = alertsFor('BMG', [{ month: SEP, documents: 2, before: null }], facts(SEP, [doc('INV2400', 'Acme Fleet'), doc('JE1301', null)]));
    expect(two[0].body).toBe('INV2400 (Acme Fleet) and JE1301 differ from what NetSuite posted. Differences vs NetSuite shows why.');
    const five = alertsFor('BMG', [{ month: SEP, documents: 5, before: null }], facts(SEP, [doc('INV2400', 'Acme Fleet'), doc('JE1301', null)]));
    expect(five[0].body).toBe('5 documents differ from what NetSuite posted, the largest INV2400 (Acme Fleet) and JE1301. Differences vs NetSuite shows why.');
  });

  it("says how many accounts differ when no document of a kind FleetSuite posts is behind it (a typed entry)", () => {
    const [alert] = alertsFor('BMG', [{ month: SEP, documents: 0, before: null }], facts(SEP, [], 2));
    expect(alert.body).toBe("FleetSuite's entries differ from NetSuite's on 2 accounts. Differences vs NetSuite shows why.");
  });

  it('says how many documents differ now and before for a month that already differed', () => {
    const both = alertsFor('BMG', [{ month: DEC, documents: 2, before: 1 }], facts(DEC, [doc('INV1413', 'Beta Corp'), doc('INV2400', 'Acme Fleet')]));
    expect(both[0]).toEqual({
      title: "BMG's books: more of December 2025 differs from NetSuite",
      body: '2 documents differ now, 1 before: INV1413 (Beta Corp) and INV2400 (Acme Fleet). Differences vs NetSuite shows why.',
      url: '/admin/books/differences?company=BMG&month=2025-12',
    });
    const more = alertsFor('BMG', [{ month: DEC, documents: 4, before: 1 }], facts(DEC, [doc('INV1413', 'Beta Corp'), doc('INV2400', 'Acme Fleet')]));
    expect(more[0].body).toBe('4 documents differ now, 1 before, the largest INV1413 (Beta Corp) and INV2400 (Acme Fleet). Differences vs NetSuite shows why.');
    const none = alertsFor('BMG', [{ month: DEC, documents: 1, before: 0 }], facts(DEC, [doc('INV2400', 'Acme Fleet')]));
    expect(none[0].body).toBe('1 document differs now, none before: INV2400 (Acme Fleet). Differences vs NetSuite shows why.');
  });

  it('names a document by the copy of NetSuite\'s documents, else by its NetSuite id', () => {
    const [byCopy] = alertsFor('BMG', [{ month: SEP, documents: 1, before: null }], facts(SEP, [doc(null, 'Acme Fleet')]));
    expect(byCopy.body).toBe('INV-COPY (Acme Fleet) differs from what NetSuite posted. Differences vs NetSuite shows why.');
    const bare: DiffDocumentData = { ...doc(null, null), copy: null };
    const [byId] = alertsFor('BMG', [{ month: SEP, documents: 1, before: null }], facts(SEP, [bare]));
    expect(byId.body).toBe('NetSuite 9001 differs from what NetSuite posted. Differences vs NetSuite shows why.');
  });

  it('tells about up to three months one by one, and more in one notification linking to the first', () => {
    const three = [AUG, SEP, OCT].map((month): MonthNews => ({ month, documents: 1, before: null }));
    expect(alertsFor('BMG', three, new Map()).map((a) => a.url)).toEqual([
      '/admin/books/differences?company=BMG&month=2026-08',
      '/admin/books/differences?company=BMG&month=2026-09',
      '/admin/books/differences?company=BMG&month=2026-10',
    ]);
    const five = ['2025-01-01', '2025-02-01', '2025-03-01', DEC, SEP].map((month): MonthNews => ({ month, documents: 1, before: null }));
    expect(alertsFor('BMG', five, new Map())).toEqual([{
      title: "BMG's books: 5 months differ from NetSuite now",
      body: 'January 2025, February 2025, March 2025 and 2 more. Differences vs NetSuite shows why.',
      url: '/admin/books/differences?company=BMG&month=2025-01',
    }]);
  });

  it('adds why it may be, when the last posting run or copy failed', () => {
    const [alert] = alertsFor('BMG', [{ month: SEP, documents: 1, before: null }], facts(SEP, [doc('INV2400', 'Acme Fleet')]),
      'The last posting run failed, so FleetSuite may be behind.');
    expect(alert.body).toBe('INV2400 (Acme Fleet) differs from what NetSuite posted. Differences vs NetSuite shows why. '
      + 'The last posting run failed, so FleetSuite may be behind.');
  });

  it('tells nothing when nothing changed', () => {
    expect(alertsFor('BMG', [], new Map())).toEqual([]);
  });
});

/** An item at a location as Stock by item compares it. */
const line = (over: Partial<StockLine> = {}): StockLine => ({
  key: '9001|11', itemId: '9001', item: 'LDR-24', description: 'Ladder rack 24 in', locationId: '11', location: 'Wentzville',
  companies: ['BMG'], start: { quantity: 10, value: 150000 }, fleetsuite: { quantity: 12, value: 180000 },
  netsuite: { quantity: 10, value: 150000 }, countDiffers: true, valueDiffers: true, leftover: false, documents: 3, lastDate: '2026-10-16',
  ...over,
});
const fresh = (l: StockLine): StockNews => ({ line: l, further: false });

describe('stockAlertsFor', () => {
  it("names the item, its location and both counts, and links to the item's moves at that location", () => {
    expect(stockAlertsFor([fresh(line())])).toEqual([{
      title: 'Stock: LDR-24 at Wentzville no longer matches NetSuite',
      body: 'Ladder rack 24 in. FleetSuite counts 12 and NetSuite 10. Stock by item shows why.',
      url: '/admin/books/stock/item?item=9001&location=11',
      about: 'stock',
    }]);
  });

  it('says when the counts are further apart than when the super admins last heard', () => {
    const [alert] = stockAlertsFor([{ line: line({ fleetsuite: { quantity: 12, value: 0 }, netsuite: { quantity: 5, value: null } }), further: true }]);
    expect(alert.title).toBe("Stock: LDR-24 at Wentzville is further off NetSuite's count");
    expect(alert.body).toBe('Ladder rack 24 in. FleetSuite counts 12 and NetSuite 5, further apart than before. Stock by item shows why.');
  });

  it('names an item counted company-wide without a location, and one with no description by its name alone', () => {
    const [alert] = stockAlertsFor([fresh(line({
      key: '9003', itemId: '9003', item: 'VINYL-3M', description: null, locationId: null, location: null,
      fleetsuite: { quantity: 1250.5, value: 0 }, netsuite: { quantity: 1200.25, value: null },
    }))]);
    expect(alert).toEqual({
      title: 'Stock: VINYL-3M no longer matches NetSuite',
      body: 'FleetSuite counts 1,250.5 and NetSuite 1,200.25. Stock by item shows why.',
      url: '/admin/books/stock/item?item=9003',
      about: 'stock',
    });
  });

  it('tells about up to three items one by one, and more in one notification linking to the items that differ', () => {
    const items = ['LDR-24', 'BIN-10', 'VINYL-3M', 'CAM-2', 'LBR-8'].map((item, i) => fresh(line({ key: `${9001 + i}|11`, itemId: String(9001 + i), item })));
    expect(stockAlertsFor(items.slice(0, 3)).map((a) => a.url)).toEqual([
      '/admin/books/stock/item?item=9001&location=11',
      '/admin/books/stock/item?item=9002&location=11',
      '/admin/books/stock/item?item=9003&location=11',
    ]);
    expect(stockAlertsFor(items)).toEqual([{
      title: 'Stock: 5 counts differ from NetSuite now',
      body: 'LDR-24 at Wentzville, BIN-10 at Wentzville, VINYL-3M at Wentzville and 2 more. Stock by item shows why.',
      url: '/admin/books/stock?only=differs',
      about: 'stock',
    }]);
  });

  it('tells nothing when nothing changed', () => {
    expect(stockAlertsFor([])).toEqual([]);
  });
});

describe('balanceAlertsFor', () => {
  const ACME = 'c0000000-0000-4000-8000-00000000000a';
  const news = (over: Partial<BalanceNews> = {}): BalanceNews => ({
    kind: 'customer', party: ACME, name: 'Acme Fleet', documents: 1, before: null, named: ['INV1007'], ...over,
  });

  it("names the customer, the company and the document, and links to the customer's balance", () => {
    expect(balanceAlertsFor('BMG', [news()])).toEqual([{
      title: "BMG's books: Acme Fleet's balance no longer matches NetSuite",
      body: 'INV1007 differs from what NetSuite posted. Customer and vendor balances shows why.',
      url: `/admin/books/balances/party?company=BMG&kind=customer&party=${ACME}`,
      about: 'balance',
    }]);
  });

  it('names the two newest documents, and how many differ when there are more, or how many before', () => {
    expect(balanceAlertsFor('BMG', [news({ documents: 2, named: ['INV1007', 'PMT2001'] })])[0].body)
      .toBe('INV1007 and PMT2001 differ from what NetSuite posted. Customer and vendor balances shows why.');
    expect(balanceAlertsFor('BMG', [news({ documents: 5, named: ['INV1007', 'PMT2001'] })])[0].body)
      .toBe('5 documents differ from what NetSuite posted, the newest INV1007 and PMT2001. Customer and vendor balances shows why.');
    const [more] = balanceAlertsFor('1084', [news({ documents: 3, before: 1, named: ['INV1007', 'PMT2001'] })]);
    expect(more.title).toBe("1084's books: more of Acme Fleet's documents differ from NetSuite");
    expect(more.body).toBe('3 documents differ now, 1 before, the newest INV1007 and PMT2001. Customer and vendor balances shows why.');
    expect(balanceAlertsFor('BMG', [news({ documents: 2, before: 1, named: ['INV1007', 'PMT2001'] })])[0].body)
      .toBe('2 documents differ now, 1 before: INV1007 and PMT2001. Customer and vendor balances shows why.');
    // When the documents couldn't be looked up, how many.
    expect(balanceAlertsFor('BMG', [news({ documents: 2, named: [] })])[0].body)
      .toBe('2 documents differ from what NetSuite posted. Customer and vendor balances shows why.');
  });

  it("names a vendor, and the lines FleetSuite can't name for what they are", () => {
    expect(balanceAlertsFor('BMG', [news({ kind: 'vendor', party: '7001', name: 'Landlord LLC', named: ['BILL4002'] })])[0]).toMatchObject({
      title: "BMG's books: Landlord LLC's balance no longer matches NetSuite",
      url: '/admin/books/balances/party?company=BMG&kind=vendor&party=7001',
    });
    expect(balanceAlertsFor('BMG', [news({ party: '', name: 'Not matched to a FleetSuite customer' })])[0]).toMatchObject({
      title: "BMG's books: the balance of customers not matched to FleetSuite no longer matches NetSuite",
      url: '/admin/books/balances/party?company=BMG&kind=customer&party=none',
    });
    expect(balanceAlertsFor('BMG', [news({ kind: 'vendor', party: '', name: 'No vendor named', before: 1, documents: 2 })])[0].title)
      .toBe("BMG's books: more documents of payables naming no vendor differ from NetSuite");
  });

  it('tells about up to three balances one by one, and more in one notification linking to the ones that differ', () => {
    const many = ['Acme Fleet', 'Bravo Transit', 'Charlie Cab', 'Delta Rentals'].map((name, i) => news({ party: ACME.replace(/a$/, String(i)), name }));
    expect(balanceAlertsFor('BMG', many.slice(0, 3))).toHaveLength(3);
    expect(balanceAlertsFor('BMG', many)).toEqual([{
      title: "BMG's books: 4 customer balances differ from NetSuite now",
      body: 'Acme Fleet, Bravo Transit, Charlie Cab and 1 more. Customer and vendor balances shows why.',
      url: '/admin/books/balances?company=BMG&kind=customer&only=differs',
      about: 'balance',
    }]);
    const mixed = [...many.slice(0, 3), news({ kind: 'vendor', party: '', name: 'No vendor named' })];
    expect(balanceAlertsFor('BMG', [mixed[3], ...mixed.slice(0, 3)])[0]).toMatchObject({
      title: "BMG's books: 4 customer and vendor balances differ from NetSuite now",
      body: 'The payables naming no vendor, Acme Fleet, Bravo Transit and 1 more. Customer and vendor balances shows why.',
      url: '/admin/books/balances?company=BMG&kind=vendor&only=differs',
    });
  });

  it('adds why it may be, when the last posting run or copy failed, and tells nothing when nothing changed', () => {
    expect(balanceAlertsFor('BMG', [news()], 'The last posting run failed, so FleetSuite may be behind.')[0].body)
      .toBe('INV1007 differs from what NetSuite posted. Customer and vendor balances shows why. The last posting run failed, so FleetSuite may be behind.');
    expect(balanceAlertsFor('BMG', [])).toEqual([]);
  });
});

describe('deepLinks.booksBalances and booksBalance', () => {
  it("open Customer and vendor balances on a company's customers or vendors, and one balance, '' as none", () => {
    expect(deepLinks.booksBalances('BMG', 'customer')).toBe('/admin/books/balances?company=BMG&kind=customer');
    expect(deepLinks.booksBalances('1084', 'vendor', true)).toBe('/admin/books/balances?company=1084&kind=vendor&only=differs');
    expect(deepLinks.booksBalance('BMG', 'vendor', '7001')).toBe('/admin/books/balances/party?company=BMG&kind=vendor&party=7001');
    expect(deepLinks.booksBalance('BMG', 'customer', '', true)).toBe('/admin/books/balances/party?company=BMG&kind=customer&party=none&only=differs');
  });
});

describe('deepLinks.booksStock and booksStockItem', () => {
  it('open Stock by item, on the items that differ when asked, and one item with a location picked out', () => {
    expect(deepLinks.booksStock()).toBe('/admin/books/stock');
    expect(deepLinks.booksStock(true)).toBe('/admin/books/stock?only=differs');
    expect(deepLinks.booksStockItem('9001')).toBe('/admin/books/stock/item?item=9001');
    expect(deepLinks.booksStockItem('9001', '11')).toBe('/admin/books/stock/item?item=9001&location=11');
    expect(deepLinks.booksStockItem('9001', null)).toBe('/admin/books/stock/item?item=9001');
  });
});

describe('deepLinks.booksDifferences', () => {
  it('opens Differences vs NetSuite on the company and month, as the page reads them', () => {
    expect(deepLinks.booksDifferences('1084', '2026-09-01')).toBe('/admin/books/differences?company=1084&month=2026-09');
    expect(deepLinks.booksDifferences('BMG', '2026-09')).toBe('/admin/books/differences?company=BMG&month=2026-09');
  });
});
