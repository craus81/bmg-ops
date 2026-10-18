import { describe, it, expect } from 'vitest';
import {
  alertsFor, lookOf, nextCheck, parseCheckState,
  type CompanyCheck, type DifferingMonths, type MonthFacts, type MonthNews,
} from './daily-check';
import type { DiffDocumentData } from './differences';
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

describe('deepLinks.booksDifferences', () => {
  it('opens Differences vs NetSuite on the company and month, as the page reads them', () => {
    expect(deepLinks.booksDifferences('1084', '2026-09-01')).toBe('/admin/books/differences?company=1084&month=2026-09');
    expect(deepLinks.booksDifferences('BMG', '2026-09')).toBe('/admin/books/differences?company=BMG&month=2026-09');
  });
});
