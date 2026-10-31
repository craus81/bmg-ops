import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { deepLinks } from '@/lib/deep-links';
import { detailDocuments, runningBalances, type AccountDocumentData, type AccountDocumentsData, type DetailDocument } from './report-detail';

const row = (r: Partial<AccountDocumentData> & Pick<AccountDocumentData, 'doc'>): AccountDocumentData => ({
  netsuite: '0', fleetsuite: '0', kind: null, type: null, number: null, month: null, date: null, name: null, memo: null,
  entry_no: null, entries: 0, ...r,
});
const found = (rows: AccountDocumentData[]): AccountDocumentsData => ({ documents: rows.length, differing: 0, netsuite: '0', fleetsuite: '0', rows });

describe('the documents on a line', () => {
  it('reads each amount as the line shows it', () => {
    const rows = [row({ doc: '1001', netsuite: '-500.00', fleetsuite: '-450.00', kind: 'invoice', type: 'CustInvc', number: 'INV1001' })];
    expect(detailDocuments(found(rows), -1)[0]).toMatchObject({ netsuite: 50000, fleetsuite: 45000 });
    expect(detailDocuments(found(rows), 1)[0]).toMatchObject({ netsuite: -50000, fleetsuite: -45000 });
    // No minus zero.
    expect(Object.is(detailDocuments(found([row({ doc: '7', netsuite: '0', fleetsuite: '1.00' })]), -1)[0].netsuite, 0)).toBe(true);
  });

  it("names each kind of document as NetSuite does, else as FleetSuite's own", () => {
    const shown = detailDocuments(found([
      row({ doc: '1', type: 'CustInvc', number: 'INV1', kind: 'invoice' }),
      row({ doc: '2', type: 'ExpRept', number: 'EXP2' }),
      row({ doc: '3', type: 'Odd', number: 'X3' }),
      // FleetSuite's own entries, and documents of NetSuite's the copy no longer has.
      row({ doc: 'entry:a', kind: 'manual', entry_no: 41, fleetsuite: '1.00' }),
      row({ doc: 'entry:b', kind: 'opening_balance', entry_no: 2, fleetsuite: '1.00' }),
      row({ doc: '4', kind: 'invoice_cost', fleetsuite: '1.00' }),
      row({ doc: '5', kind: 'payment', fleetsuite: '1.00' }),
    ]), 1);
    expect(shown.map((d) => [d.type, d.number])).toEqual([
      ['Invoice', 'INV1'],
      ['Expense Report', 'EXP2'],
      ['Odd', 'X3'],
      ['Typed entry (FleetSuite only)', 'Entry 41'],
      ['Opening balance (FleetSuite only)', 'Entry 2'],
      ['Cost of goods on invoices', 'NetSuite 4'],
      ['Payment', 'NetSuite 5'],
    ]);
  });

  it("says which side alone has a document, and when it's of a kind FleetSuite doesn't post yet", () => {
    const shown = detailDocuments(found([
      row({ doc: '1', type: 'CustInvc', netsuite: '5.00', fleetsuite: '4.00', kind: 'invoice' }),
      row({ doc: '2', type: 'CustInvc', netsuite: '5.00' }),
      row({ doc: '3', type: 'ExpRept', netsuite: '5.00' }),
      row({ doc: '4', type: 'CustInvc', fleetsuite: '5.00', kind: 'invoice' }),
      row({ doc: 'entry:a', kind: 'manual', fleetsuite: '5.00' }),
    ]), 1);
    expect(shown.map((d) => d.only)).toEqual([null, 'netsuite', 'not_posted', 'fleetsuite', 'fleetsuite']);
  });

  it('opens each document of a kind FleetSuite posts on its check, under the month Invoices vs NetSuite lists it in', () => {
    const shown = detailDocuments(found([
      // An invoice is listed in the month NetSuite posted it to, whatever its date.
      row({ doc: '1', type: 'CustInvc', kind: 'invoice', month: '2026-10-01', date: '2026-09-30' }),
      // One FleetSuite hasn't posted yet is found by its NetSuite type.
      row({ doc: '2', type: 'CustCred', month: '2026-09-01', date: '2026-09-02' }),
      // A payment by its own date, a journal entry in NetSuite's month, a bill in the Bills switch.
      row({ doc: '3', type: 'CustPymt', kind: 'payment', month: '2026-10-01', date: '2026-09-30' }),
      row({ doc: '4', type: 'Journal', kind: 'journal_entry', month: '2026-09-01', date: '2026-08-31' }),
      row({ doc: '5', type: 'VendBill', kind: 'vendor_bill', month: '2026-09-01', date: '2026-09-04' }),
      // An invoice's cost lines under Stock and cost.
      row({ doc: '6', type: 'CustInvc', kind: 'invoice_cost', month: '2026-09-01', date: '2026-09-04' }),
      // None: dated before the books start, a kind FleetSuite doesn't post, a typed entry.
      row({ doc: '7', type: 'CustPymt', kind: 'payment', month: '2025-01-01', date: '2024-12-30' }),
      row({ doc: '8', type: 'ExpRept', month: '2026-09-01', date: '2026-09-05' }),
      row({ doc: 'entry:a', kind: 'manual', date: '2026-09-06' }),
    ]), 1);
    expect(shown.map((d) => d.check)).toEqual([
      { kind: 'invoice', month: '2026-10-01' },
      { kind: 'credit_memo', month: '2026-09-01' },
      { kind: 'payment', month: '2026-09-01' },
      { kind: 'journal_entry', month: '2026-09-01' },
      { kind: 'bill', month: '2026-09-01' },
      { kind: 'stock', month: '2026-09-01' },
      null,
      null,
      null,
    ]);
  });
});

describe("each side's running balance (the Excel download)", () => {
  const doc = (doc: string, date: string | null, fleetsuite: number, netsuite: number): DetailDocument => ({
    doc, date, type: 'Invoice', number: doc, name: null, memo: null, fleetsuite, netsuite, only: null, check: null,
  });
  const order = (rows: ReturnType<typeof runningBalances>) =>
    rows.map((r) => (r.kind === 'document' ? r.document.doc : r.kind === 'closing' ? r.month : r.kind));

  it("runs each side from the line's balance before the months, document by document, to the line", () => {
    expect(runningBalances(
      { starting: { fleetsuite: 1000, netsuite: 1000 }, ending: { fleetsuite: 1700, netsuite: 1650 } },
      [],
      [doc('1', '2026-08-03', 500, 500), doc('2', '2026-08-10', 200, 150)],
    )).toEqual([
      { kind: 'starting', balance: { fleetsuite: 1000, netsuite: 1000 } },
      { kind: 'document', document: doc('1', '2026-08-03', 500, 500), balance: { fleetsuite: 1500, netsuite: 1500 } },
      { kind: 'document', document: doc('2', '2026-08-10', 200, 150), balance: { fleetsuite: 1700, netsuite: 1650 } },
      { kind: 'ending', balance: { fleetsuite: 1700, netsuite: 1650 }, reached: { fleetsuite: 1700, netsuite: 1650 } },
    ]);
  });

  it('starts income and expenses from nothing, with no balance before', () => {
    const rows = runningBalances({ starting: null, ending: { fleetsuite: 300, netsuite: 250 } }, [], [doc('1', '2026-01-05', 100, 100), doc('2', '2026-02-05', 200, 150)]);
    expect(order(rows)).toEqual(['1', '2', 'ending']);
    expect(rows[0]).toMatchObject({ balance: { fleetsuite: 100, netsuite: 100 } });
    expect(rows[2]).toEqual({ kind: 'ending', balance: { fleetsuite: 300, netsuite: 250 }, reached: { fleetsuite: 300, netsuite: 250 } });
  });

  it("brings each year's net income in on January 1, before anything dated that day, whatever order they come in", () => {
    const rows = runningBalances(
      { starting: { fleetsuite: 0, netsuite: 0 }, ending: { fleetsuite: 40, netsuite: 35 } },
      [{ month: '2027-01-01', closed: { fleetsuite: 20, netsuite: 20 } }, { month: '2026-01-01', closed: { fleetsuite: 10, netsuite: 5 } }],
      // An undated document steps the balance without bringing a year in.
      [doc('a', '2025-12-31', 1, 1), doc('b', '2026-01-01', 2, 2), doc('c', null, 3, 3), doc('d', '2026-12-31', 4, 4)],
    );
    expect(order(rows)).toEqual(['starting', 'a', '2026-01-01', 'b', 'c', 'd', '2027-01-01', 'ending']);
    expect(rows[2]).toEqual({ kind: 'closing', month: '2026-01-01', amount: { fleetsuite: 10, netsuite: 5 }, balance: { fleetsuite: 11, netsuite: 6 } });
    expect(rows[6]).toMatchObject({ balance: { fleetsuite: 40, netsuite: 35 } });
    expect(rows[7]).toMatchObject({ reached: { fleetsuite: 40, netsuite: 35 } });
  });

  it("says where the rows come to when they don't reach the line", () => {
    expect(runningBalances({ starting: { fleetsuite: 0, netsuite: 0 }, ending: { fleetsuite: 900, netsuite: 900 } }, [], [doc('1', '2026-08-03', 500, 400)]).at(-1))
      .toEqual({ kind: 'ending', balance: { fleetsuite: 900, netsuite: 900 }, reached: { fleetsuite: 500, netsuite: 400 } });
    // Nothing moved: the two ends alone.
    expect(runningBalances({ starting: { fleetsuite: 7, netsuite: 7 }, ending: { fleetsuite: 7, netsuite: 7 } }, [], [])).toEqual([
      { kind: 'starting', balance: { fleetsuite: 7, netsuite: 7 } },
      { kind: 'ending', balance: { fleetsuite: 7, netsuite: 7 }, reached: { fleetsuite: 7, netsuite: 7 } },
    ]);
  });
});

describe('the books deep links', () => {
  it("opens an account line's detail on the line's report and months, only what differs when asked", () => {
    expect(deepLinks.booksAccountDetail('BMG', '123', 'balance_sheet', '2026-09-01', '2026-09-01'))
      .toBe('/admin/books/reports/detail?company=BMG&account=123&report=balance_sheet&from=2026-09&to=2026-09');
    expect(deepLinks.booksAccountDetail('1084', 'fs:a1', 'profit_and_loss', '2026-01', '2026-09', true))
      .toBe('/admin/books/reports/detail?company=1084&account=fs%3Aa1&report=profit_and_loss&from=2026-01&to=2026-09&only=differs');
  });

  it('goes back to the report, and opens a document on Invoices vs NetSuite', () => {
    expect(deepLinks.booksReport('BMG', 'trial_balance', '2026-09-01', '2026-09-01'))
      .toBe('/admin/books/reports?company=BMG&report=trial_balance&from=2026-09&to=2026-09');
    expect(deepLinks.booksDocument('BMG', 'invoice', '2026-10-01', '1003')).toBe('/admin/books/invoices?company=BMG&kind=invoice&month=2026-10&doc=1003');
  });
});
