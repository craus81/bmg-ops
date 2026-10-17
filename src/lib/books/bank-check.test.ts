import { describe, it, expect } from 'vitest';
import type { ChartAccount, InvoiceBooks } from './invoice-check';
import { checkBankMonth, workOutBankMonth, type BankMonthData, type WorkedBankDocument } from './bank-check';

// Made-up books: '100' the checking account, '105' Undeposited Funds, '110'
// savings, '120' receivables, '480' other income, '660' bank fees.
const NAMES: Record<string, [string, string]> = {
  '100': ['1000 Checking', 'bank'], '105': ['1050 Undeposited Funds', 'other_current_asset'], '110': ['1100 Savings', 'bank'],
  '120': ['1200 Receivables', 'accounts_receivable'], '480': ['4800 Other Income', 'other_income'], '660': ['6600 Bank Fees', 'expense'],
};
const CHART: ChartAccount[] = Object.entries(NAMES).map(([id, [label, type]]) => ({
  netsuite_account_id: id, number: label.split(' ')[0], name: label.split(' ').slice(1).join(' '), account_type: type,
  company: null, active: true, is_summary: false,
}));
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';

type MonthDocument = BankMonthData['documents'][number];
type MonthLine = MonthDocument['lines'][number];
const gl = (lineId: string, account: string, cents: number, fields: Partial<MonthLine> = {}): MonthLine => ({
  line_id: lineId, account, debit: cents > 0 ? (cents / 100).toFixed(2) : '0.00', credit: cents < 0 ? (-cents / 100).toFixed(2) : '0.00',
  memo: null, entity_id: null, name: null, customer_id: null, ...fields,
});
const monthDocument = (fields: Partial<MonthDocument>): MonthDocument => ({
  netsuite_id: '8001', type: 'Deposit', number: 'DEP0412', date: '2026-09-15', posting_month: '2026-09-01', companies: ['BMG'],
  // Two customer payments taken out of Undeposited Funds and put in the bank.
  lines: [
    gl('0', '100', 150000, { memo: 'Deposit 9/15' }),
    gl('1', '105', -100000, { entity_id: '310', name: 'A Customer', customer_id: CUSTOMER }),
    gl('2', '105', -50000, { entity_id: '311', name: 'Another Customer', memo: 'PMT1977' }),
  ],
  ...fields,
});
const MONTH: BankMonthData = {
  documents: [
    monthDocument({}),
    // Money moved to savings, with no number: the list goes by its memo.
    monthDocument({
      netsuite_id: '8002', type: 'Transfer', number: null, date: '2026-09-20',
      lines: [gl('1', '110', 500000, { memo: 'To savings' }), gl('2', '100', -500000, { memo: 'To savings' })],
    }),
    // Dated in August, booked by NetSuite into September, with lines for 1084 too; a refund from the bank among its deposits.
    monthDocument({
      netsuite_id: '8003', number: 'DEP0398', date: '2026-08-31', companies: ['1084', 'BMG'],
      lines: [
        gl('0', '100', 7500),
        gl('1', '120', -2500, { entity_id: '310', name: 'A Customer', customer_id: CUSTOMER, memo: 'Paid at the counter' }),
        gl('2', '480', -5000, { memo: 'Fee refund' }),
      ],
    }),
  ],
};

describe('workOutBankMonth', () => {
  it('takes every line as it is, with its memo and name, and names each by its number, else NetSuite\'s id', () => {
    const { documents, account } = workOutBankMonth(MONTH, { company: 'BMG', chart: CHART });
    expect(documents.map((w) => [w.entry.type, w.number, w.checked.status, w.checked.lines.map((l) => [l.lineId, l.account, l.cents])])).toEqual([
      ['Deposit', 'DEP0412', 'matches', [['0', '100', 150000], ['1', '105', -100000], ['2', '105', -50000]]],
      ['Transfer', 'NetSuite 8002', 'matches', [['1', '110', 500000], ['2', '100', -500000]]],
      ['Deposit', 'DEP0398', 'matches', [['0', '100', 7500], ['1', '120', -2500], ['2', '480', -5000]]],
    ]);
    // Undeposited Funds isn't receivables, so its lines carry no customer; a receivables line carries its own.
    expect(documents[0].checked.lines.map((l) => [l.memo, l.customerId, l.vendorRef])).toEqual([
      ['Deposit 9/15', null, null], ['A Customer', null, null], ['Another Customer · PMT1977', null, null],
    ]);
    expect(documents[2].checked.lines.map((l) => [l.memo, l.customerId])).toEqual([
      [null, null], ['A Customer · Paid at the counter', CUSTOMER], ['Fee refund', null],
    ]);
    expect(account('105')).toBe('1050 Undeposited Funds');
    expect(account('999')).toBe('NetSuite account 999');
  });

  it('can\'t work out one whose lines for the company don\'t balance, or whose amounts can\'t be read', () => {
    const { documents } = workOutBankMonth({
      documents: [
        monthDocument({ lines: [gl('1', '110', 500000), gl('2', '100', -450000)] }),
        monthDocument({ netsuite_id: '8004', lines: [gl('1', '110', 100), { ...gl('2', '100', -100), credit: 'n/a' }] }),
      ],
    }, { company: 'BMG', chart: CHART });
    expect(documents.map((w) => [w.checked.status, w.checked.problems, w.checked.lines])).toEqual([
      ['unworkable', [{ kind: 'unbalanced' }], []],
      ['unworkable', [{ kind: 'unreadable' }], []],
    ]);
  });
});

describe('checkBankMonth', () => {
  it('checks every bank deposit and transfer of the company\'s booked into the month, saying which each is', () => {
    const m = checkBankMonth(MONTH, { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 3, matches: 3, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.invoices.map((d) => [d.netsuiteId, d.type, d.number, d.date, d.customer, d.total, d.voided, d.status, d.reasons])).toEqual([
      // Its first memo, else its first name, stands in for a customer, and its total is its debits.
      ['8001', 'Deposit', 'DEP0412', '2026-09-15', 'Deposit 9/15', 150000, false, 'matches', []],
      ['8002', 'Transfer', 'NetSuite 8002', '2026-09-20', 'To savings', 500000, false, 'matches', []],
      ['8003', 'Deposit', 'DEP0398', '2026-08-31', 'Paid at the counter', 7500, false, 'matches', []],
    ]);
    expect(m.invoices[0].rows.map((r) => [r.lineId, r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.netsuite?.cents, r.same])).toEqual([
      ['0', 'Deposit 9/15', '100', 150000, 150000, true],
      ['1', 'A Customer', '105', -100000, -100000, true],
      ['2', 'Another Customer · PMT1977', '105', -50000, -50000, true],
    ]);
    expect(m.invoices.map((d) => d.booked)).toEqual([undefined, undefined, { month: '2026-09-01', date: '2026-09-01' }]);
    expect(m.invoices.map((d) => d.books)).toEqual([undefined, undefined, undefined]);
    expect(m.reasons).toEqual([]);
    expect(m.accounts).toEqual({
      100: '1000 Checking', 105: '1050 Undeposited Funds', 110: '1100 Savings', 120: '1200 Receivables', 480: '4800 Other Income',
    });
    expect(m.notes).toEqual([
      '1 bank deposit or transfer dated in another month is here because NetSuite booked it into this month: DEP0398.',
      "1 bank deposit or transfer also has lines for the other company. Only this company's lines are shown here and make up its entry: DEP0398.",
    ]);
  });

  it('counts the ones that can\'t be worked out by reason, and says what the books hold for each when they post', () => {
    const asked: string[] = [];
    const books = (w: WorkedBankDocument): InvoiceBooks => {
      asked.push(w.number);
      if (w.number === 'DEP0412') return { entryNo: 52, next: null, earlier: [] };
      return { entryNo: null, next: w.checked.status === 'matches' ? 'post' : null, earlier: [] };
    };
    const m = checkBankMonth({
      documents: [
        monthDocument({}),
        monthDocument({ netsuite_id: '8005', type: 'Transfer', number: 'TRN0031', lines: [gl('1', '110', 500000), gl('2', '100', -450000)] }),
      ],
    }, { company: 'BMG', chart: CHART }, books);
    expect(asked).toEqual(['DEP0412', 'TRN0031']);
    expect(m.summary).toEqual({
      invoices: 2, matches: 1, differs: 0, unworkable: 1, waiting: 0, withCost: 0, posted: 1, pending: 0, nothingToPost: { voided: 0, zero: 0 },
    });
    expect(m.reasons).toEqual([{
      key: 'unbalanced', text: "Its lines for this company don't balance on their own, so FleetSuite's books can't take them as one entry.",
      invoices: 1, examples: ['TRN0031'],
    }]);
    // One with neither a memo nor a name has nothing in a customer's place.
    expect(m.invoices.map((d) => [d.number, d.type, d.customer, d.books?.entryNo])).toEqual([
      ['DEP0412', 'Deposit', 'Deposit 9/15', 52], ['TRN0031', 'Transfer', null, null],
    ]);
  });

  it('names several in one note each, and checks a month with none', () => {
    const m = checkBankMonth({
      documents: [
        monthDocument({ netsuite_id: '8006', number: 'DEP0390', date: '2026-08-29', companies: ['1084', 'BMG'] }),
        monthDocument({ netsuite_id: '8007', type: 'Transfer', number: 'TRN0040', date: '2026-10-01', companies: ['1084', 'BMG'] }),
      ],
    }, { company: 'BMG', chart: CHART });
    expect(m.notes).toEqual([
      '2 bank deposits and transfers dated in other months are here because NetSuite booked them into this month: DEP0390, TRN0040.',
      "2 bank deposits and transfers also have lines for the other company. Only this company's lines are shown here and make up their entry: "
        + 'DEP0390, TRN0040.',
    ]);
    expect(checkBankMonth({ documents: [] }, { company: 'BMG', chart: CHART })).toEqual({
      summary: { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 }, reasons: [], notes: [], invoices: [], accounts: {},
    });
  });
});
