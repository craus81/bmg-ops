import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));

import { ageDocument, buildAgings, type OpenDocumentData, type OpenDocumentsData } from './agings';
import { UNNAMED, type PartyBalance, type PartyBalances } from './party-balances';

const TODAY = '2026-10-31';

const doc = (over: Partial<OpenDocumentData> & Pick<OpenDocumentData, 'party' | 'doc'>): OpenDocumentData => ({
  type: 'CustInvc',
  number: null,
  date: '2026-09-03',
  netsuite_due: null,
  fleetsuite_due: null,
  netsuite: '0',
  fleetsuite: '0',
  netsuite_lines: true,
  fleetsuite_lines: true,
  ...over,
});

const balance = (party: string, name: string, fleetsuite: number, netsuite: number): PartyBalance => ({
  party, name, netsuiteIds: party ? [`90${party.length}`] : [], opening: 0, fleetsuite, netsuite,
  documents: 0, differing: 0, differs: fleetsuite !== netsuite, members: [], membersCount: 0,
});

const balances = (kind: 'customer' | 'vendor', parties: PartyBalance[], unsplit = 0): PartyBalances => ({
  kind,
  accounts: [],
  parties,
  unsplit,
  openingComplete: true,
  totals: {
    fleetsuite: parties.reduce((s, p) => s + p.fleetsuite, unsplit),
    netsuite: parties.reduce((s, p) => s + p.netsuite, unsplit),
  },
  differing: parties.filter((p) => p.differs).length,
});

describe('ageDocument', () => {
  it('ages an invoice from its due date, each side, as the balance reads', () => {
    const aged = ageDocument(doc({
      party: 'acme', doc: '1001', number: 'INV1001', netsuite_due: '2026-10-03', fleetsuite_due: '2026-10-03',
      netsuite: '200.00', fleetsuite: '200.00',
    }), TODAY, 1);
    expect(aged).toEqual({
      doc: '1001', type: 'CustInvc', number: 'INV1001', date: '2026-09-03',
      due: { fleetsuite: '2026-10-03', netsuite: '2026-10-03' },
      days: { fleetsuite: 28, netsuite: 28 },
      bucket: { fleetsuite: 'd1_30', netsuite: 'd1_30' },
      open: { fleetsuite: 20000, netsuite: 20000 },
      onlyIn: null,
      differs: false,
    });
  });

  it("turns a vendor's amounts round, so a bill is what BMG owes and a bill credit takes from it", () => {
    const bill = ageDocument(doc({
      party: '7002', doc: '4002', type: 'VendBill', netsuite_due: '2026-10-06', netsuite: '-150.00', fleetsuite_lines: false,
    }), TODAY, -1);
    expect(bill).toMatchObject({ open: { fleetsuite: 0, netsuite: 15000 }, onlyIn: 'netsuite', differs: true });
    expect(Object.is(bill.open.fleetsuite, 0)).toBe(true);
    const credit = ageDocument(doc({ party: '7001', doc: '4005', type: 'VendCred', date: '2026-10-05', netsuite: '20.00', fleetsuite: '20.00' }), TODAY, -1);
    expect(credit).toMatchObject({ open: { fleetsuite: -2000, netsuite: -2000 }, days: { fleetsuite: 26, netsuite: 26 }, differs: false });
  });

  it('ages a document with no due date from its date, and one with neither as current', () => {
    expect(ageDocument(doc({ party: 'acme', doc: '1010', type: 'CustCred', date: '2026-10-10', netsuite: '-50', fleetsuite: '-50' }), TODAY, 1))
      .toMatchObject({ due: { fleetsuite: null, netsuite: null }, days: { fleetsuite: 21, netsuite: 21 }, bucket: { fleetsuite: 'd1_30', netsuite: 'd1_30' } });
    expect(ageDocument(doc({ party: 'acme', doc: '1012', date: null, netsuite: '5', fleetsuite: '5' }), TODAY, 1))
      .toMatchObject({ date: null, days: { fleetsuite: null, netsuite: null }, bucket: { fleetsuite: 'current', netsuite: 'current' } });
  });

  it('says it differs when what is open differs, or how late it is on a side with something open', () => {
    const late = (fleetsuite: string, netsuite: string) => ageDocument(doc({
      party: 'bravo', doc: '1003', date: '2026-08-15', netsuite_due: '2026-09-14', fleetsuite_due: '2026-10-14', netsuite, fleetsuite,
    }), TODAY, 1);
    expect(late('200', '200')).toMatchObject({ bucket: { fleetsuite: 'd1_30', netsuite: 'd31_60' }, days: { fleetsuite: 17, netsuite: 47 }, differs: true });
    expect(late('0', '0').differs).toBe(false);
    expect(late('200', '210').differs).toBe(true);
    // The same bucket, a different number of days: no difference.
    expect(ageDocument(doc({ party: 'x', doc: '1', netsuite_due: '2026-10-03', fleetsuite_due: '2026-10-04', netsuite: '1', fleetsuite: '1' }), TODAY, 1).differs)
      .toBe(false);
  });

  it("says which side's ledger alone has the document", () => {
    expect(ageDocument(doc({ party: 'zulu', doc: '1008', fleetsuite: '75', netsuite_lines: false }), TODAY, 1).onlyIn).toBe('fleetsuite');
    expect(ageDocument(doc({ party: 'acme', doc: '900', netsuite: '150', fleetsuite: '150', netsuite_lines: false, fleetsuite_lines: false }), TODAY, 1).onlyIn)
      .toBeNull();
  });
});

describe('buildAgings', () => {
  // Acme: three invoices and an unapplied 40.00 payment. Bravo: one invoice due later in FleetSuite's own copy.
  // Charlie: two invoices, the same days late. Delta: only a payment, which differs. Echo: an invoice only
  // FleetSuite has, for a customer the balances don't list. Tango: a balance that differs and nothing open. The
  // customers FleetSuite can't name: a balance only on NetSuite's side, listed last though their name sorts
  // before Tango's. Hotel: at nothing either side, left out.
  const BALANCES = balances('customer', [
    balance('acme', 'Acme Fleet', 21000, 31000),
    balance('bravo', 'Bravo Transit', 20000, 20000),
    balance('charlie', 'Charlie Cab', 15000, 15000),
    balance('delta', 'Delta Dairy', -7500, -7000),
    balance('tango', 'Tango Tires', 0, 3000),
    balance('', UNNAMED.customer, 0, 500),
    balance('hotel', 'Hotel Haulers', 0, 0),
  ], 1000);
  const DATA: OpenDocumentsData = {
    linked: true,
    documents: 6,
    parties: [
      { party: 'acme', name: 'Acme Fleet', netsuite_ids: ['9001'] },
      { party: 'echo', name: 'Echo Express', netsuite_ids: [] },
    ],
    rows: [
      doc({ party: 'acme', doc: '1001', number: 'INV1001', netsuite_due: '2026-10-03', fleetsuite_due: '2026-10-03', netsuite: '200.00', fleetsuite: '200.00' }),
      doc({ party: 'acme', doc: '1007', number: 'INV1007', date: '2026-10-02', netsuite_due: '2026-11-01', fleetsuite_due: '2026-11-01', netsuite: '100.00', fleetsuite_lines: false }),
      doc({ party: 'acme', doc: '1000', number: 'INV1000', date: '2026-06-01', netsuite_due: '2026-07-01', fleetsuite_due: '2026-07-01', netsuite: '50', fleetsuite: '50' }),
      doc({ party: 'bravo', doc: '1003', number: 'INV1003', date: '2026-08-15', netsuite_due: '2026-09-14', fleetsuite_due: '2026-10-14', netsuite: '200', fleetsuite: '200' }),
      doc({ party: 'charlie', doc: '1011', number: 'INV11', netsuite_due: '2026-10-20', fleetsuite_due: '2026-10-20', netsuite: '100', fleetsuite: '100' }),
      doc({ party: 'charlie', doc: '1009', number: 'INV9', netsuite_due: '2026-10-20', fleetsuite_due: '2026-10-20', netsuite: '50', fleetsuite: '50' }),
      doc({ party: 'echo', doc: '1008', date: '2026-09-28', fleetsuite: '75', netsuite_lines: false }),
    ],
  };

  it('puts each customer by how late its open documents are, the rest of its balance apart, those that differ first', () => {
    const agings = buildAgings(BALANCES, DATA, 'customer', TODAY);
    expect(agings.parties.map((p) => [
      p.party, p.name, p.netsuiteIds, p.differs,
      Object.values(p.buckets).map((b) => b.fleetsuite), Object.values(p.buckets).map((b) => b.netsuite),
      p.notOpen, p.balance,
    ])).toEqual([
      ['acme', 'Acme Fleet', ['9001'], true, [0, 20000, 0, 0, 5000], [10000, 20000, 0, 0, 5000], { fleetsuite: -4000, netsuite: -4000 }, { fleetsuite: 21000, netsuite: 31000 }],
      ['bravo', 'Bravo Transit', ['905'], true, [0, 20000, 0, 0, 0], [0, 0, 20000, 0, 0], { fleetsuite: 0, netsuite: 0 }, { fleetsuite: 20000, netsuite: 20000 }],
      // Equal balances in FleetSuite's books: by name, the customers FleetSuite can't name last.
      ['echo', 'Echo Express', [], true, [0, 0, 7500, 0, 0], [0, 0, 0, 0, 0], { fleetsuite: -7500, netsuite: 0 }, { fleetsuite: 0, netsuite: 0 }],
      ['tango', 'Tango Tires', ['905'], true, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], { fleetsuite: 0, netsuite: 3000 }, { fleetsuite: 0, netsuite: 3000 }],
      ['', UNNAMED.customer, [], true, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], { fleetsuite: 0, netsuite: 500 }, { fleetsuite: 0, netsuite: 500 }],
      ['delta', 'Delta Dairy', ['905'], true, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], { fleetsuite: -7500, netsuite: -7000 }, { fleetsuite: -7500, netsuite: -7000 }],
      ['charlie', 'Charlie Cab', ['907'], false, [0, 15000, 0, 0, 0], [0, 15000, 0, 0, 0], { fleetsuite: 0, netsuite: 0 }, { fleetsuite: 15000, netsuite: 15000 }],
    ]);
    expect(agings.differing).toBe(6);
    expect(agings).toMatchObject({ kind: 'customer', today: TODAY, linked: true, netsuiteDocuments: 6 });
  });

  it("lists each customer's documents the most overdue first by FleetSuite's books, then by number", () => {
    const agings = buildAgings(BALANCES, DATA, 'customer', TODAY);
    const docs = (party: string) => agings.parties.find((p) => p.party === party)!.documents.map((d) => [d.number, d.days.fleetsuite]);
    expect(docs('acme')).toEqual([['INV1000', 122], ['INV1001', 28], ['INV1007', -1]]);
    expect(docs('charlie')).toEqual([['INV9', 11], ['INV11', 11]]);
    expect(agings.parties.find((p) => p.party === 'echo')!.documents[0]).toMatchObject({ onlyIn: 'fleetsuite', differs: true });
  });

  it('adds every side up to the balances, with what of the starting entry is not split by name', () => {
    const agings = buildAgings(BALANCES, DATA, 'customer', TODAY);
    expect(agings.totals).toEqual({
      buckets: {
        current: { fleetsuite: 0, netsuite: 10000 },
        d1_30: { fleetsuite: 55000, netsuite: 35000 },
        d31_60: { fleetsuite: 7500, netsuite: 20000 },
        d61_90: { fleetsuite: 0, netsuite: 0 },
        d90plus: { fleetsuite: 5000, netsuite: 5000 },
      },
      notOpen: { fleetsuite: -19000, netsuite: -7500 },
      unsplit: 1000,
      balance: { fleetsuite: 49500, netsuite: 63500 },
    });
    for (const side of ['fleetsuite', 'netsuite'] as const) {
      const bucketed = Object.values(agings.totals.buckets).reduce((s, b) => s + b[side], 0);
      expect(bucketed + agings.totals.notOpen[side] + agings.totals.unsplit).toBe(agings.totals.balance[side]);
    }
  });

  it("leaves everything in what's not in an open invoice when NetSuite's documents couldn't be read", () => {
    const agings = buildAgings(BALANCES, null, 'customer', TODAY);
    expect(agings).toMatchObject({ linked: false, netsuiteDocuments: 0 });
    expect(agings.parties.map((p) => [p.party, p.notOpen.fleetsuite, p.notOpen.netsuite, p.documents.length])).toEqual([
      ['acme', 21000, 31000, 0],
      ['tango', 0, 3000, 0],
      ['', 0, 500, 0],
      ['delta', -7500, -7000, 0],
      ['bravo', 20000, 20000, 0],
      ['charlie', 15000, 15000, 0],
    ]);
    expect(Object.values(agings.totals.buckets).every((b) => b.fleetsuite === 0 && b.netsuite === 0)).toBe(true);
  });

  it("ages a vendor's bills as what BMG owes, naming a vendor neither list names by its NetSuite id", () => {
    const agings = buildAgings(balances('vendor', [balance('7001', 'Landlord LLC', 78000, 78000)]), {
      linked: true,
      documents: 3,
      parties: [{ party: '7001', name: 'Landlord LLC', netsuite_ids: ['7001'] }, { party: '7003', name: null, netsuite_ids: ['7003'] }],
      rows: [
        doc({ party: '7001', doc: '4004', type: 'VendBill', date: '2026-10-01', netsuite_due: '2026-11-01', fleetsuite_due: '2026-11-01', netsuite: '-800', fleetsuite: '-800' }),
        doc({ party: '7001', doc: '4005', type: 'VendCred', date: '2026-10-05', netsuite: '20', fleetsuite: '20' }),
        doc({ party: '7003', doc: '4009', type: 'VendBill', date: '2026-10-01', netsuite_due: '2026-10-15', netsuite: '-90', fleetsuite_lines: false }),
      ],
    }, 'vendor', TODAY);
    expect(agings.parties.map((p) => [p.party, p.name, Object.values(p.buckets).map((b) => b.netsuite), p.notOpen])).toEqual([
      ['7003', 'NetSuite vendor 7003', [0, 9000, 0, 0, 0], { fleetsuite: 0, netsuite: -9000 }],
      ['7001', 'Landlord LLC', [80000, -2000, 0, 0, 0], { fleetsuite: 0, netsuite: 0 }],
    ]);
  });
});
