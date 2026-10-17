import { describe, it, expect } from 'vitest';
import type { ChartAccount, InvoiceBooks } from './invoice-check';
import { checkStockMonth, workOutStockMonth, type StockMonthData, type WorkedStockDocument } from './stock-check';

// Made-up books: '130' inventory, '205' stock received but not billed, '500'
// cost of goods sold, '520' inventory adjustments, '120' receivables.
const NAMES: Record<string, [string, string]> = {
  '130': ['1300 Inventory', 'other_current_asset'], '205': ['2050 Received Not Billed', 'other_current_liability'],
  '500': ['5000 Cost of Goods Sold', 'cost_of_goods_sold'], '520': ['5200 Inventory Adjustments', 'cost_of_goods_sold'],
  '120': ['1200 Receivables', 'accounts_receivable'],
};
const CHART: ChartAccount[] = Object.entries(NAMES).map(([id, [label, type]]) => ({
  netsuite_account_id: id, number: label.split(' ')[0], name: label.split(' ').slice(1).join(' '), account_type: type,
  company: null, active: true, is_summary: false,
}));
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';

type MonthDocument = StockMonthData['documents'][number];
type MonthLine = MonthDocument['lines'][number];
const gl = (lineId: string, account: string, cents: number, fields: Partial<MonthLine> = {}): MonthLine => ({
  line_id: lineId, account, debit: cents > 0 ? (cents / 100).toFixed(2) : '0.00', credit: cents < 0 ? (-cents / 100).toFixed(2) : '0.00',
  memo: null, entity_id: null, name: null, customer_id: null, ...fields,
});
const customer = { entity_id: '310', name: 'A Customer', customer_id: CUSTOMER };
const monthDocument = (fields: Partial<MonthDocument>): MonthDocument => ({
  netsuite_id: '8101', type: 'ItemShip', number: 'IF1201', date: '2026-09-15', posting_month: '2026-09-01', companies: ['BMG'],
  // A part shipped to a customer: its cost out of inventory.
  lines: [gl('1', '500', 4000, { memo: 'WIDGET-1', ...customer }), gl('2', '130', -4000, { memo: 'WIDGET-1', ...customer })],
  ...fields,
});
const MONTH: StockMonthData = {
  documents: [
    monthDocument({}),
    // An invoice that wasn't fulfilled first: its cost lines alone.
    monthDocument({
      netsuite_id: '8102', type: 'CustInvc', number: 'INV2312', date: '2026-09-18',
      lines: [gl('3', '500', 1250, customer), gl('4', '130', -1250, customer)],
    }),
    // Parts received against a purchase order, dated in August, booked by NetSuite into September, with lines for 1084 too.
    monthDocument({
      netsuite_id: '8103', type: 'ItemRcpt', number: 'IR0412', date: '2026-08-31', companies: ['1084', 'BMG'],
      lines: [gl('1', '130', 10000, { memo: 'PO311' }), gl('2', '205', -10000, { entity_id: '50', name: 'Sample Supply Co' })],
    }),
    // A part returned on a credit memo, with no number: the list goes by its first name.
    monthDocument({
      netsuite_id: '8104', type: 'CustCred', number: null, date: '2026-09-25',
      lines: [gl('5', '130', 2000, customer), gl('6', '500', -2000, customer)],
    }),
  ],
};

describe('workOutStockMonth', () => {
  it('takes every line as it is, with its memo and name, and names each by its number, else NetSuite\'s id', () => {
    const { documents, account } = workOutStockMonth(MONTH, { company: 'BMG', chart: CHART });
    expect(documents.map((w) => [w.entry.type, w.number, w.checked.status, w.checked.lines.map((l) => [l.lineId, l.account, l.cents])])).toEqual([
      ['ItemShip', 'IF1201', 'matches', [['1', '500', 4000], ['2', '130', -4000]]],
      ['CustInvc', 'INV2312', 'matches', [['3', '500', 1250], ['4', '130', -1250]]],
      ['ItemRcpt', 'IR0412', 'matches', [['1', '130', 10000], ['2', '205', -10000]]],
      ['CustCred', 'NetSuite 8104', 'matches', [['5', '130', 2000], ['6', '500', -2000]]],
    ]);
    // Neither cost of goods nor inventory is receivables, so the customer is named on its lines but not carried.
    expect(documents[0].checked.lines.map((l) => [l.memo, l.customerId, l.vendorRef])).toEqual([
      ['A Customer · WIDGET-1', null, null], ['A Customer · WIDGET-1', null, null],
    ]);
    // Nor is stock received but not billed payables, so no vendor goes on it.
    expect(documents[2].checked.lines.map((l) => [l.memo, l.vendorRef])).toEqual([['PO311', null], ['Sample Supply Co', null]]);
    expect(account('205')).toBe('2050 Received Not Billed');
    expect(account('999')).toBe('NetSuite account 999');
  });

  it('can\'t work out one whose lines for the company don\'t balance, or whose amounts can\'t be read', () => {
    const { documents } = workOutStockMonth({
      documents: [
        monthDocument({ type: 'InvAdjst', lines: [gl('1', '520', 1500), gl('2', '130', -1000)] }),
        monthDocument({ netsuite_id: '8105', type: 'Build', lines: [gl('1', '130', 100), { ...gl('2', '130', -100), credit: 'n/a' }] }),
      ],
    }, { company: 'BMG', chart: CHART });
    expect(documents.map((w) => [w.checked.status, w.checked.problems, w.checked.lines])).toEqual([
      ['unworkable', [{ kind: 'unbalanced' }], []],
      ['unworkable', [{ kind: 'unreadable' }], []],
    ]);
  });
});

describe('checkStockMonth', () => {
  it('checks every stock document of the company\'s booked into the month, saying which kind each is', () => {
    const m = checkStockMonth(MONTH, { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 4, matches: 4, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.invoices.map((d) => [d.netsuiteId, d.type, d.number, d.date, d.customer, d.total, d.voided, d.status, d.reasons])).toEqual([
      // Its first memo, else its first name, stands in for a customer, and its total is its debits.
      ['8101', 'ItemShip', 'IF1201', '2026-09-15', 'WIDGET-1', 4000, false, 'matches', []],
      ['8102', 'CustInvc', 'INV2312', '2026-09-18', 'A Customer', 1250, false, 'matches', []],
      ['8103', 'ItemRcpt', 'IR0412', '2026-08-31', 'PO311', 10000, false, 'matches', []],
      ['8104', 'CustCred', 'NetSuite 8104', '2026-09-25', 'A Customer', 2000, false, 'matches', []],
    ]);
    expect(m.invoices[1].rows.map((r) => [r.lineId, r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.netsuite?.cents, r.same, r.cost])).toEqual([
      ['3', 'A Customer', '500', 1250, 1250, true, false],
      ['4', 'A Customer', '130', -1250, -1250, true, false],
    ]);
    expect(m.invoices.map((d) => d.booked)).toEqual([undefined, undefined, { month: '2026-09-01', date: '2026-09-01' }, undefined]);
    expect(m.invoices.map((d) => d.books)).toEqual([undefined, undefined, undefined, undefined]);
    expect(m.reasons).toEqual([]);
    expect(m.accounts).toEqual({ 130: '1300 Inventory', 205: '2050 Received Not Billed', 500: '5000 Cost of Goods Sold' });
    expect(m.notes).toEqual([
      '1 stock document dated in another month is here because NetSuite booked it into this month: IR0412.',
      "1 stock document also has lines for the other company. Only this company's lines are shown here and make up its entry: IR0412.",
    ]);
  });

  it('counts the ones that can\'t be worked out by reason, and says what the books hold for each when they post', () => {
    const asked: string[] = [];
    const books = (w: WorkedStockDocument): InvoiceBooks => {
      asked.push(w.number);
      if (w.number === 'IF1201') return { entryNo: 61, next: null, earlier: [] };
      return { entryNo: null, next: w.checked.status === 'matches' ? 'post' : null, earlier: [] };
    };
    const m = checkStockMonth({
      documents: [
        monthDocument({}),
        monthDocument({ netsuite_id: '8106', type: 'InvAdjst', number: 'ADJ0031', lines: [gl('1', '520', 1500), gl('2', '130', -1000)] }),
      ],
    }, { company: 'BMG', chart: CHART }, books);
    expect(asked).toEqual(['IF1201', 'ADJ0031']);
    expect(m.summary).toEqual({
      invoices: 2, matches: 1, differs: 0, unworkable: 1, waiting: 0, withCost: 0, posted: 1, pending: 0, nothingToPost: { voided: 0, zero: 0 },
    });
    expect(m.reasons).toEqual([{
      key: 'unbalanced', text: "Its lines for this company don't balance on their own, so FleetSuite's books can't take them as one entry.",
      invoices: 1, examples: ['ADJ0031'],
    }]);
    // One with neither a memo nor a name has nothing in a customer's place.
    expect(m.invoices.map((d) => [d.number, d.type, d.customer, d.books?.entryNo])).toEqual([
      ['IF1201', 'ItemShip', 'WIDGET-1', 61], ['ADJ0031', 'InvAdjst', null, null],
    ]);
  });

  it('names several in one note each, and checks a month with none', () => {
    const m = checkStockMonth({
      documents: [
        monthDocument({ netsuite_id: '8107', number: 'IF1190', date: '2026-08-29', companies: ['1084', 'BMG'] }),
        monthDocument({ netsuite_id: '8108', type: 'InvTrnfr', number: 'TO0040', date: '2026-10-01', companies: ['1084', 'BMG'] }),
      ],
    }, { company: 'BMG', chart: CHART });
    expect(m.notes).toEqual([
      '2 stock documents dated in other months are here because NetSuite booked them into this month: IF1190, TO0040.',
      "2 stock documents also have lines for the other company. Only this company's lines are shown here and make up their entry: "
        + 'IF1190, TO0040.',
    ]);
    expect(checkStockMonth({ documents: [] }, { company: 'BMG', chart: CHART })).toEqual({
      summary: { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 }, reasons: [], notes: [], invoices: [], accounts: {},
    });
  });
});
