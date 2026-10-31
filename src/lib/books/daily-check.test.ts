import { describe, it, expect } from 'vitest';
import {
  adjustmentAlertsFor, alertsFor, balanceAlertsFor, balanceKey, billAlertsFor, changeAlertsFor, fulfillmentAlertsFor, lookOf, mistakeAlertsFor,
  nextCheck, ownAlertsFor, parseCheckState, receiptAlertsFor, sendAlertsFor, stockAlertsFor,
  type BalanceNews, type ChangeAlertItem, type CompanyCheck, type DifferingMonths, type MistakeAlertItem, type MonthFacts, type MonthNews,
  type SendAlertItem, type StockNews,
} from './daily-check';
import type { DiffDocumentData } from './differences';
import type { OwnAdjustmentCheck } from './own-adjustment-check';
import type { OwnBillCheck } from './own-bill-check';
import type { OwnFulfillmentCheck } from './own-fulfillment-check';
import type { OwnInvoiceCheck } from './own-invoice-check';
import type { OwnReceiptCheck } from './own-receipt-check';
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

  it("reads what it holds for FleetSuite's own invoices, keyed by NetSuite's id, and drops it when it doesn't read", () => {
    const own = { known: { 5001: 2 }, noted: { 5002: 1 } };
    expect(parseCheckState({ companies: {}, own })).toEqual({ companies: {}, own });
    for (const bad of [null, 'x', { known: { 'INV5001': 1 }, noted: {} }, { known: { 5001: 0.5 }, noted: {} }, { known: {} }]) {
      expect(parseCheckState({ companies: {}, own: bad })).toEqual({ companies: {} });
    }
  });

  it("reads what it holds for FleetSuite's own fulfillments apart from its own invoices, and drops it when it doesn't read", () => {
    const fulfillments = { known: { 7001: 1 }, noted: { 7002: 2 } };
    expect(parseCheckState({ companies: {}, fulfillments })).toEqual({ companies: {}, fulfillments });
    expect(parseCheckState({ companies: {}, own: { known: {}, noted: {} }, fulfillments }))
      .toEqual({ companies: {}, own: { known: {}, noted: {} }, fulfillments });
    for (const bad of [null, 'x', { known: { IF7001: 1 }, noted: {} }, { known: { 7001: -1 }, noted: {} }, { noted: {} }]) {
      expect(parseCheckState({ companies: {}, fulfillments: bad })).toEqual({ companies: {} });
    }
  });

  it("reads what it holds for Books' own bills by NetSuite's id and own receipts by their key, and drops either when it doesn't read", () => {
    const key = '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f60';
    const bills = { known: { 8801: 2 }, noted: { 8802: 1 } };
    const receipts = { known: { [key]: 1 }, noted: {} };
    expect(parseCheckState({ companies: {}, bills, receipts })).toEqual({ companies: {}, bills, receipts });
    for (const bad of [null, 'x', { known: { 'VI-1042': 1 }, noted: {} }, { known: { 8801: 0.5 }, noted: {} }, { known: {} }]) {
      expect(parseCheckState({ companies: {}, bills: bad, receipts })).toEqual({ companies: {}, receipts });
    }
    for (const bad of [{ known: { 8801: 1 }, noted: {} }, { known: {}, noted: { [`r:${key}`]: 1 } }, { noted: {} }]) {
      expect(parseCheckState({ companies: {}, bills, receipts: bad })).toEqual({ companies: {}, bills });
    }
  });

  it("reads what it holds for the Inventory Adjusts, keyed by FleetSuite's id for each, and drops it when it doesn't read", () => {
    const id = '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c';
    const adjustments = { known: { [id]: 2 }, noted: {} };
    expect(parseCheckState({ companies: {}, adjustments })).toEqual({ companies: {}, adjustments });
    expect(parseCheckState({ companies: {}, receipts: { known: {}, noted: {} }, adjustments }))
      .toEqual({ companies: {}, receipts: { known: {}, noted: {} }, adjustments });
    // NetSuite's id for the adjustment isn't how it's kept, nor is its number.
    for (const bad of [null, 'x', { known: { 7201: 1 }, noted: {} }, { known: { 'ADJ0143': 1 }, noted: {} }, { known: { [id]: -1 }, noted: {} }, { known: { [id]: 1 } }]) {
      expect(parseCheckState({ companies: {}, adjustments: bad })).toEqual({ companies: {} });
    }
  });

  it("reads what it holds for likely mistakes, keyed by their id on Mistake checks, and drops it when it doesn't read", () => {
    const id = '0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6';
    const mistakes = { known: { [id]: 1 }, noted: {} };
    expect(parseCheckState({ companies: {}, mistakes })).toEqual({ companies: {}, mistakes });
    expect(parseCheckState({ companies: {}, fulfillments: { known: {}, noted: {} }, mistakes }))
      .toEqual({ companies: {}, fulfillments: { known: {}, noted: {} }, mistakes });
    for (const bad of [null, 'x', { known: { 7001: 1 }, noted: {} }, { known: { [`twice:${id}`]: 1 }, noted: {} }, { known: { [id]: 1 } }]) {
      expect(parseCheckState({ companies: {}, mistakes: bad })).toEqual({ companies: {} });
    }
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

  it("says NetSuite's change waits of a month closed in FleetSuite's books, before why", () => {
    const closed = new Set([SEP]);
    const [alert] = alertsFor('BMG', [{ month: SEP, documents: 1, before: null }], facts(SEP, [doc('INV2400', 'Acme Fleet')]), '', closed);
    expect(alert.body).toBe("INV2400 (Acme Fleet) differs from what NetSuite posted. September 2026 is closed in FleetSuite's books, "
      + "so NetSuite's change waits until it's reopened on Books → Months. Differences vs NetSuite shows why.");
    expect(alertsFor('BMG', [{ month: OCT, documents: 1, before: null }], facts(OCT, [doc('INV2401', 'Acme Fleet')]), '', closed)[0].body)
      .toBe('INV2401 (Acme Fleet) differs from what NetSuite posted. Differences vs NetSuite shows why.');
    // In one notification for them all, how many of them are closed.
    const five = ['2025-01-01', '2025-02-01', '2025-03-01', DEC, SEP].map((month): MonthNews => ({ month, documents: 1, before: null }));
    expect(alertsFor('BMG', five, new Map(), '', closed)[0].body).toBe('January 2025, February 2025, March 2025 and 2 more. '
      + "1 of them is closed in FleetSuite's books, so what NetSuite changed there waits until it's reopened on Books → Months. "
      + 'Differences vs NetSuite shows why.');
    expect(alertsFor('BMG', five, new Map(), '', new Set([SEP, DEC]))[0].body).toContain(
      "2 of them are closed in FleetSuite's books, so what NetSuite changed there waits until they're reopened on Books → Months.");
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

describe('ownAlertsFor', () => {
  const checked = (id: string, over: Partial<OwnInvoiceCheck> = {}): OwnInvoiceCheck => ({
    netsuiteId: id, number: `INV${id}`, date: '2026-10-20', madeFrom: 'po', madeFromText: "a PO's open quantities", customer: 'Acme Fleet',
    status: 'differs', summary: 'Sales tax: NetSuite charged $45.49 and FleetSuite worked out $21.30.',
    differing: 2, fleetsuiteTotal: 55730, netsuiteTotal: 58149, fields: [], lines: [], unknowns: [], workedOut: [], ...over,
  });
  const news = (id: string, before: number | null = null): MonthNews => ({ month: id, documents: 2, before });

  it('names the invoice and its customer, says what differs, and links to its check', () => {
    expect(ownAlertsFor([news('5001')], new Map([['5001', checked('5001')]]))).toEqual([{
      title: "Own invoices: INV5001 (Acme Fleet) differs from NetSuite's",
      body: 'Sales tax: NetSuite charged $45.49 and FleetSuite worked out $21.30. Own invoices shows why.',
      url: '/admin/books/own-invoices/invoice?id=5001',
      about: 'own',
    }]);
    const [more] = ownAlertsFor([news('5001', 1)], new Map([['5001', checked('5001', { customer: null })]]));
    expect(more.title).toBe("Own invoices: more of INV5001 differs from NetSuite's");
  });

  it('tells about up to three one by one, and more in one notification linking to the newest month\'s that differ', () => {
    const ids = ['5001', '5002', '5003', '5004'];
    const checks = new Map(ids.map((id, i) => [id, checked(id, { date: i === 2 ? '2026-11-02' : '2026-10-20' })]));
    expect(ownAlertsFor(ids.slice(0, 3).map((id) => news(id)), checks)).toHaveLength(3);
    expect(ownAlertsFor(ids.map((id) => news(id)), checks)).toEqual([{
      title: "Own invoices: 4 differ from NetSuite's now",
      body: 'INV5001 (Acme Fleet), INV5002 (Acme Fleet), INV5003 (Acme Fleet) and 1 more. Own invoices shows why.',
      url: '/admin/books/own-invoices?month=2026-11&only=differs',
      about: 'own',
    }]);
  });

  it("tells nothing of an invoice it has no check for, nor when nothing changed", () => {
    expect(ownAlertsFor([news('5009')], new Map())).toEqual([]);
    expect(ownAlertsFor([], new Map())).toEqual([]);
  });
});

describe('fulfillmentAlertsFor', () => {
  const checked = (id: string, over: Partial<OwnFulfillmentCheck> = {}): OwnFulfillmentCheck => ({
    netsuiteId: id, number: `IF${id}`, date: '2026-10-20', madeFrom: 'vehicle', madeFromText: 'a finished vehicle', customer: 'Acme Fleet',
    salesOrderId: '6001', salesOrder: 'SO6001', locationId: '2', invoice: null,
    status: 'differs', summary: "Cost: NetSuite's is $5.00 more.",
    differing: 1, fleetsuiteCost: 45500, netsuiteCost: 46000, fields: [], items: [], entry: [], unknowns: [], workedOut: [], ...over,
  });
  const news = (id: string, before: number | null = null): MonthNews => ({ month: id, documents: 1, before });

  it('names the fulfillment and its customer, says what differs, and links to its check', () => {
    expect(fulfillmentAlertsFor([news('7001')], new Map([['7001', checked('7001')]]))).toEqual([{
      title: "Own fulfillments: IF7001 (Acme Fleet) differs from NetSuite's",
      body: "Cost: NetSuite's is $5.00 more. Own fulfillments shows why.",
      url: '/admin/books/own-fulfillments/fulfillment?id=7001',
      about: 'fulfillment',
    }]);
    const [more] = fulfillmentAlertsFor([news('7001', 1)], new Map([['7001', checked('7001', { customer: null })]]));
    expect(more.title).toBe("Own fulfillments: more of IF7001 differs from NetSuite's");
  });

  it("tells about up to three one by one, and more in one notification linking to the newest month's that differ", () => {
    const ids = ['7001', '7002', '7003', '7004'];
    const checks = new Map(ids.map((id, i) => [id, checked(id, { date: i === 1 ? '2026-11-03' : '2026-10-20' })]));
    expect(fulfillmentAlertsFor(ids.slice(0, 3).map((id) => news(id)), checks)).toHaveLength(3);
    expect(fulfillmentAlertsFor(ids.map((id) => news(id)), checks)).toEqual([{
      title: "Own fulfillments: 4 differ from NetSuite's now",
      body: 'IF7001 (Acme Fleet), IF7002 (Acme Fleet), IF7003 (Acme Fleet) and 1 more. Own fulfillments shows why.',
      url: '/admin/books/own-fulfillments?month=2026-11&only=differs',
      about: 'fulfillment',
    }]);
  });

  it('tells nothing of a fulfillment it has no check for, nor when nothing changed', () => {
    expect(fulfillmentAlertsFor([news('7009')], new Map())).toEqual([]);
    expect(fulfillmentAlertsFor([], new Map())).toEqual([]);
  });
});

describe('billAlertsFor', () => {
  const checked = (id: string, over: Partial<OwnBillCheck> = {}): OwnBillCheck => ({
    netsuiteId: id, number: `VI-${id}`, date: '2026-10-20', company: 'BMG', madeFrom: 'vendor_invoice', madeFromText: 'a CNI vendor invoice',
    madeFromId: 'inv-1', madeBy: null, vendor: 'Northside Install Co.', poId: null, poNumber: null, status: 'differs',
    summary: "Amount: NetSuite's is $45.00 less.", differing: 1, fleetsuiteCents: 125000, netsuiteCents: 120500, invoiceCents: null,
    fields: [], lines: [], unknowns: [], workedOut: [], ...over,
  });
  const news = (id: string, before: number | null = null): MonthNews => ({ month: id, documents: 1, before });

  it('names the bill and its vendor, says what differs, and links to its check', () => {
    expect(billAlertsFor([news('8801')], new Map([['8801', checked('8801')]]))).toEqual([{
      title: "Own bills: Northside Install Co.'s bill VI-8801 differs from NetSuite's",
      body: "Amount: NetSuite's is $45.00 less. Own bills shows why.",
      url: deepLinks.booksOwnBill('8801'),
      about: 'bill',
    }]);
    expect(deepLinks.booksOwnBill('8801')).toBe('/admin/books/own-bills/bill?id=8801');
    const [more] = billAlertsFor([news('8801', 1)], new Map([['8801', checked('8801', { vendor: null })]]));
    expect(more.title).toBe("Own bills: more of bill VI-8801 differs from NetSuite's");
  });

  it("tells about up to three one by one, and more in one notification linking to the newest month's that differ", () => {
    const ids = ['8801', '8802', '8803', '8804'];
    const checks = new Map(ids.map((id, i) => [id, checked(id, { date: i === 1 ? '2026-11-03' : '2026-10-20', vendor: i ? 'Northside Install Co.' : null })]));
    expect(billAlertsFor(ids.slice(0, 3).map((id) => news(id)), checks)).toHaveLength(3);
    expect(billAlertsFor(ids.map((id) => news(id)), checks)).toEqual([{
      title: "Own bills: 4 differ from NetSuite's now",
      body: "Bill VI-8801, Northside Install Co.'s bill VI-8802, Northside Install Co.'s bill VI-8803 and 1 more. Own bills shows why.",
      url: '/admin/books/own-bills?month=2026-11&only=differs',
      about: 'bill',
    }]);
  });

  it('tells nothing of a bill it has no check for, nor when nothing changed', () => {
    expect(billAlertsFor([news('8809')], new Map())).toEqual([]);
    expect(billAlertsFor([], new Map())).toEqual([]);
  });
});

describe('receiptAlertsFor', () => {
  const keys = ['0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f61', '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f62',
    '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f63', '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f64'];
  const checked = (key: string, over: Partial<OwnReceiptCheck> = {}): OwnReceiptCheck => ({
    receiptKey: key, netsuiteId: '7101', number: 'IR-2288', date: '2026-10-21', company: 'BMG', poId: '5001', poNumber: 'PO453-ACME',
    vendor: 'Acme Truck Racks', location: "O'Fallon", what: '12 RACK-48', status: 'differs',
    summary: "NetSuite's receipt IR-2288 has 10 of RACK-48. FleetSuite received 12.", differing: 2, fleetsuiteCents: 214000,
    netsuiteCents: 178333, fields: [], items: [], netsuiteError: null, receiving: { posted: 1, manualNeeded: 0, manualDone: 0 },
    unknowns: [], workedOut: [], ...over,
  });
  const news = (key: string, before: number | null = null): MonthNews => ({ month: key, documents: 2, before });

  it('names the PO and its vendor, says what differs, and links to its check', () => {
    expect(receiptAlertsFor([news(keys[0])], new Map([[keys[0], checked(keys[0])]]))).toEqual([{
      title: "Own receipts: the receipt on PO453-ACME (Acme Truck Racks) differs from NetSuite's",
      body: "NetSuite's receipt IR-2288 has 10 of RACK-48. FleetSuite received 12. Own receipts shows why.",
      url: `/admin/books/own-receipts/receipt?key=${keys[0]}`,
      about: 'receipt',
    }]);
    const [more] = receiptAlertsFor([news(keys[0], 1)], new Map([[keys[0], checked(keys[0], { vendor: null })]]));
    expect(more.title).toBe("Own receipts: more of the receipt on PO453-ACME differs from NetSuite's");
  });

  it("tells about up to three one by one, and more in one notification linking to the newest month's that differ", () => {
    const checks = new Map(keys.map((key, i) => [key, checked(key, { poNumber: `PO45${3 + i}-ACME`, date: i === 2 ? '2026-11-02' : '2026-10-21' })]));
    expect(receiptAlertsFor(keys.slice(0, 3).map((key) => news(key)), checks)).toHaveLength(3);
    expect(receiptAlertsFor(keys.map((key) => news(key)), checks)).toEqual([{
      title: "Own receipts: 4 differ from NetSuite's now",
      body: 'PO453-ACME (Acme Truck Racks), PO454-ACME (Acme Truck Racks), PO455-ACME (Acme Truck Racks) and 1 more. Own receipts shows why.',
      url: '/admin/books/own-receipts?month=2026-11&only=differs',
      about: 'receipt',
    }]);
  });

  it('tells nothing of a receipt it has no check for, nor when nothing changed', () => {
    expect(receiptAlertsFor([news(keys[3])], new Map())).toEqual([]);
    expect(receiptAlertsFor([], new Map())).toEqual([]);
  });
});

describe('adjustmentAlertsFor', () => {
  const ids = ['4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b71', '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b72',
    '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b73', '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b74'];
  const checked = (id: string, over: Partial<OwnAdjustmentCheck> = {}): OwnAdjustmentCheck => ({
    id, netsuiteId: '7201', number: 'ADJ0143', date: '2026-10-30', itemId: '9002', item: 'BIN-10', description: null, assetAccount: '190',
    locationId: '1', location: "O'Fallon", change: -2, changeText: '2 fewer', mode: 'delta', entered: 2, onHandBefore: 10,
    reason: 'Damaged', note: null, madeBy: 'Pat Example', status: 'differs',
    summary: "Value: NetSuite's value is $1.00 more.", differing: 1, fleetsuiteValue: -3000, netsuiteValue: -3100,
    before: { count: 10, valueCents: 15000 }, each: 1500, accountId: '520', fields: [], entry: [], unknowns: [], workedOut: [], ...over,
  });
  const news = (id: string, before: number | null = null): MonthNews => ({ month: id, documents: 1, before });

  it('names the adjustment, its item and the change, says what differs, and links to its check', () => {
    expect(adjustmentAlertsFor([news(ids[0])], new Map([[ids[0], checked(ids[0])]]))).toEqual([{
      title: "Own adjustments: ADJ0143 (BIN-10, 2 fewer) differs from NetSuite's",
      body: "Value: NetSuite's value is $1.00 more. Own adjustments shows why.",
      url: `/admin/books/own-adjustments/adjustment?id=${ids[0]}`,
      about: 'adjustment',
    }]);
    const [more] = adjustmentAlertsFor([news(ids[0], 1)], new Map([[ids[0], checked(ids[0], { change: 4, changeText: '4 more' })]]));
    expect(more.title).toBe("Own adjustments: more of ADJ0143 (BIN-10, 4 more) differs from NetSuite's");
  });

  it("tells about up to three one by one, and more in one notification linking to the newest month's that differ", () => {
    const checks = new Map(ids.map((id, i) => [id, checked(id, { number: `ADJ014${3 + i}`, date: i === 2 ? '2026-11-02' : '2026-10-30' })]));
    expect(adjustmentAlertsFor(ids.slice(0, 3).map((id) => news(id)), checks)).toHaveLength(3);
    expect(adjustmentAlertsFor(ids.map((id) => news(id)), checks)).toEqual([{
      title: "Own adjustments: 4 differ from NetSuite's now",
      body: 'ADJ0143 (BIN-10, 2 fewer), ADJ0144 (BIN-10, 2 fewer), ADJ0145 (BIN-10, 2 fewer) and 1 more. Own adjustments shows why.',
      url: '/admin/books/own-adjustments?month=2026-11&only=differs',
      about: 'adjustment',
    }]);
  });

  it('tells nothing of an adjustment it has no check for, nor when nothing changed', () => {
    expect(adjustmentAlertsFor([news(ids[3])], new Map())).toEqual([]);
    expect(adjustmentAlertsFor([], new Map())).toEqual([]);
  });
});

describe('mistakeAlertsFor', () => {
  const ids = ['0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f1', '0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f2',
    '0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f3', '0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f4'];
  const item = (id: string, over: Partial<MistakeAlertItem> = {}): MistakeAlertItem => ({
    id, company: 'BMG', kind: 'twice', party: 'Metro Fuel Services',
    why: 'Two bills with the same amount and the same invoice number, INV-20931: one dated Oct 3, the other Oct 9.', ...over,
  });
  const news = (id: string): MonthNews => ({ month: id, documents: 1, before: null });

  it('names the vendor and what looks wrong, says why, and opens it on Mistake checks', () => {
    expect(mistakeAlertsFor([news(ids[0])], new Map([[ids[0], item(ids[0])]]))).toEqual([{
      title: 'Mistake checks: Metro Fuel Services may be entered twice',
      body: 'Two bills with the same amount and the same invoice number, INV-20931: one dated Oct 3, the other Oct 9. Mistake checks shows it.',
      url: `/admin/books/mistake-checks?company=BMG&item=${ids[0]}`,
      about: 'mistake',
    }]);
    const titles = (['far_off', 'missing', 'odd_account'] as const).map((kind) =>
      mistakeAlertsFor([news(ids[0])], new Map([[ids[0], item(ids[0], { kind, party: null })]]))[0].title);
    expect(titles).toEqual([
      'Mistake checks: A vendor is far off their usual',
      "Mistake checks: A vendor's monthly charge hasn't come",
      'Mistake checks: A vendor is coded to an odd account',
    ]);
  });

  it("tells about up to three one by one, entered twice first, and more in one notification opening the company's list", () => {
    const kinds = ['missing', 'twice', 'odd_account', 'far_off'] as const;
    const items = new Map(ids.map((id, i) => [id, item(id, { kind: kinds[i], party: `Vendor ${i + 1}` })]));
    expect(mistakeAlertsFor(ids.slice(0, 3).map(news), items).map((a) => a.title)).toEqual([
      'Mistake checks: Vendor 2 may be entered twice',
      "Mistake checks: Vendor 1's monthly charge hasn't come",
      'Mistake checks: Vendor 3 is coded to an odd account',
    ]);
    expect(mistakeAlertsFor(ids.map(news), items)).toEqual([{
      title: 'Mistake checks: 4 likely mistakes in NetSuite',
      body: 'Vendor 2 (entered twice), Vendor 4 (far off usual), Vendor 1 (monthly charge missing) and 1 more. Mistake checks shows why.',
      url: '/admin/books/mistake-checks?company=BMG',
      about: 'mistake',
    }]);
    items.set(ids[3], item(ids[3], { company: '1084' }));
    expect(mistakeAlertsFor(ids.map(news), items)[0].url).toBe('/admin/books/mistake-checks');
  });

  it("tells nothing of one it can't name, nor when nothing is new", () => {
    expect(mistakeAlertsFor([news(ids[0])], new Map())).toEqual([]);
    expect(mistakeAlertsFor([], new Map())).toEqual([]);
  });
});

describe('deepLinks.booksMistakeChecks', () => {
  it('opens Mistake checks, on a company, and on one item there', () => {
    expect(deepLinks.booksMistakeChecks()).toBe('/admin/books/mistake-checks');
    expect(deepLinks.booksMistakeChecks('1084')).toBe('/admin/books/mistake-checks?company=1084');
    expect(deepLinks.booksMistakeChecks(null, 'abc')).toBe('/admin/books/mistake-checks?item=abc');
    expect(deepLinks.booksMistakeChecks('BMG', 'abc')).toBe('/admin/books/mistake-checks?company=BMG&item=abc');
  });
});

describe('deepLinks.booksOwnInvoices and booksOwnInvoice', () => {
  it('open Own invoices on a month, on the ones that differ when asked, and one invoice', () => {
    expect(deepLinks.booksOwnInvoices()).toBe('/admin/books/own-invoices');
    expect(deepLinks.booksOwnInvoices('2026-10-01')).toBe('/admin/books/own-invoices?month=2026-10');
    expect(deepLinks.booksOwnInvoices('2026-10-20', true)).toBe('/admin/books/own-invoices?month=2026-10&only=differs');
    expect(deepLinks.booksOwnInvoices(null, true)).toBe('/admin/books/own-invoices?only=differs');
    expect(deepLinks.booksOwnInvoice('5001')).toBe('/admin/books/own-invoices/invoice?id=5001');
  });
});

describe('deepLinks.booksOwnFulfillments and booksOwnFulfillment', () => {
  it('open Own fulfillments on a month, on the ones that differ when asked, and one fulfillment', () => {
    expect(deepLinks.booksOwnFulfillments()).toBe('/admin/books/own-fulfillments');
    expect(deepLinks.booksOwnFulfillments('2026-10-01')).toBe('/admin/books/own-fulfillments?month=2026-10');
    expect(deepLinks.booksOwnFulfillments('2026-10-20', true)).toBe('/admin/books/own-fulfillments?month=2026-10&only=differs');
    expect(deepLinks.booksOwnFulfillments(null, true)).toBe('/admin/books/own-fulfillments?only=differs');
    expect(deepLinks.booksOwnFulfillment('7001')).toBe('/admin/books/own-fulfillments/fulfillment?id=7001');
  });
});

describe('deepLinks.booksOwnAdjustments and booksOwnAdjustment', () => {
  it('open Own adjustments on a month, on the ones that differ when asked, and one Inventory Adjust', () => {
    expect(deepLinks.booksOwnAdjustments()).toBe('/admin/books/own-adjustments');
    expect(deepLinks.booksOwnAdjustments('2026-10-30')).toBe('/admin/books/own-adjustments?month=2026-10');
    expect(deepLinks.booksOwnAdjustments('2026-10-01', true)).toBe('/admin/books/own-adjustments?month=2026-10&only=differs');
    expect(deepLinks.booksOwnAdjustments(null, true)).toBe('/admin/books/own-adjustments?only=differs');
    expect(deepLinks.booksOwnAdjustment('4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c'))
      .toBe('/admin/books/own-adjustments/adjustment?id=4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c');
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

describe('sendAlertsFor', () => {
  const ids = ['5e1d0000-0000-4000-8000-000000000001', '5e1d0000-0000-4000-8000-000000000002',
    '5e1d0000-0000-4000-8000-000000000003', '5e1d0000-0000-4000-8000-000000000004'];
  // 2:51 PM in O'Fallon.
  const item = (id: string, over: Partial<SendAlertItem> = {}): SendAlertItem => ({
    id, what: 'Change to a sales order', at: '2026-10-31T19:51:00Z', who: 'Jessie', error: 'Service unavailable', ...over,
  });

  it('names the send, when, who sent it and why FleetSuite is unsure, and opens it on the NetSuite feed', () => {
    expect(sendAlertsFor([item(ids[0])])).toEqual([{
      title: 'NetSuite feed: not sure about the change to a sales order',
      body: 'Sent Oct 31, 2:51 PM by Jessie: Service unavailable. NetSuite may have done it anyway, so look for it there before anyone tries again.',
      url: `/admin/books/netsuite-feed?send=${ids[0]}`,
      about: 'send',
    }]);
  });

  it("says when it never heard back, leaves out who for a scheduled job, and cuts a long reason at a word", () => {
    expect(sendAlertsFor([item(ids[0], { what: 'New journal entry', who: null, error: null })])[0]).toMatchObject({
      title: 'NetSuite feed: not sure about the new journal entry',
      body: 'Sent Oct 31, 2:51 PM: FleetSuite never heard back from NetSuite. NetSuite may have done it anyway, so look for it there before anyone tries again.',
    });
    const long = `NetSuite answered: ${'the record is locked by another user '.repeat(6)}`;
    const [cut] = sendAlertsFor([item(ids[0], { error: long })]);
    const reason = cut.body.slice('Sent Oct 31, 2:51 PM by Jessie: '.length, cut.body.indexOf(' NetSuite may have'));
    expect(reason).toMatch(/^NetSuite answered: the record is locked .* by\u2026$/);
    expect(reason.length).toBeLessThanOrEqual(161);
    expect(sendAlertsFor([item(ids[0], { error: 'NetSuite didn\u2019t answer in time!' })])[0].body).toContain(': NetSuite didn\u2019t answer in time! NetSuite may');
  });

  it('tells about up to three one by one, and more in one notification opening the feed', () => {
    const items = ids.map((id, i) => item(id, { what: ['New invoice', 'New bill', 'Change to an item', 'Deletion of a contact'][i] }));
    expect(sendAlertsFor(items.slice(0, 3)).map((a) => a.url)).toEqual(ids.slice(0, 3).map((id) => deepLinks.booksNetsuiteFeed(id)));
    expect(sendAlertsFor(items)).toEqual([{
      title: "NetSuite feed: 4 sends FleetSuite isn't sure about",
      body: 'The new invoice, the new bill, the change to an item and 1 more. '
        + 'NetSuite may have done them anyway, so look for each there before anyone tries again.',
      url: '/admin/books/netsuite-feed',
      about: 'send',
    }]);
    expect(sendAlertsFor([])).toEqual([]);
  });
});

describe('changeAlertsFor', () => {
  const ids = ['c4a90000-0000-4000-8000-000000000001', 'c4a90000-0000-4000-8000-000000000002',
    'c4a90000-0000-4000-8000-000000000003', 'c4a90000-0000-4000-8000-000000000004'];
  const item = (id: string, over: Partial<ChangeAlertItem> = {}): ChangeAlertItem => ({
    id, kindName: 'Customer', name: 'Acme Fleet Services', fieldName: 'Email', fleetsuite: 'billing@acmefleet.example',
    netsuite: 'ap@acmefleet.example', ...over,
  });

  it('names the field, the record and what each has, and opens it on Changed in NetSuite', () => {
    expect(changeAlertsFor([item(ids[0])])).toEqual([{
      title: 'Email changed in NetSuite for Acme Fleet Services',
      body: 'NetSuite has "ap@acmefleet.example" where FleetSuite has "billing@acmefleet.example". '
        + "FleetSuite's stays until someone keeps it, which sends it on to NetSuite, or takes NetSuite's.",
      url: `/admin/books/changed-in-netsuite?change=${ids[0]}`,
      about: 'change',
    }]);
  });

  it('says when NetSuite has none, and cuts a long value at a word', () => {
    expect(changeAlertsFor([item(ids[0], { fieldName: 'Billing address', netsuite: null })])[0].body)
      .toBe('NetSuite has no billing address where FleetSuite has "billing@acmefleet.example". '
        + "FleetSuite's stays until someone keeps it, which sends it on to NetSuite, or takes NetSuite's.");
    const long = `${'Suite 100 Corporate Park Drive '.repeat(4)}O'Fallon`;
    const [cut] = changeAlertsFor([item(ids[0], { fieldName: 'Billing address', netsuite: long })]);
    const quoted = cut.body.slice('NetSuite has '.length, cut.body.indexOf(' where FleetSuite'));
    expect(quoted).toBe('"Suite 100 Corporate Park Drive Suite 100 Corporate Park Drive Suite 100\u2026"');
    expect(quoted.length).toBeLessThanOrEqual(83);
    expect(changeAlertsFor([item(ids[0], { netsuite: 'x'.repeat(80) })])[0].body).toContain(`"${'x'.repeat(80)}"`);
  });

  it('tells about up to three one by one, and more in one notification opening the list', () => {
    const items = ids.map((id, i) => item(id, {
      name: ['Acme Fleet Services', 'Fellers', 'Ridge Supply Co', 'Harbor Fleet'][i], fieldName: ['Email', 'Phone', 'Name', 'Billing address'][i],
    }));
    expect(changeAlertsFor(items.slice(0, 3)).map((a) => a.url)).toEqual(ids.slice(0, 3).map((id) => deepLinks.booksChangedInNetsuite(id)));
    expect(changeAlertsFor(items)).toEqual([{
      title: 'Changed in NetSuite: 4 customer and vendor details',
      body: 'The email of Acme Fleet Services, the phone of Fellers, the name of Ridge Supply Co and 1 more. '
        + "FleetSuite's stays until someone keeps it, which sends it on to NetSuite, or takes NetSuite's.",
      url: '/admin/books/changed-in-netsuite',
      about: 'change',
    }]);
    expect(changeAlertsFor([])).toEqual([]);
  });
});
