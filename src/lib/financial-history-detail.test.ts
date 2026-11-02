import { describe, it, expect } from 'vitest';
import { booksAccountSections, invoicedByMonth, netsuiteAccountSections, quickbooksAccountSections } from './financial-history-detail';
import type { RestletPnlRow } from './netsuite';
import { booksPnl } from './books/money-screens';
import type { ReportAccount, ReportAmount, ReportData } from './books/reports';

const ns = (accountType: string, accountName: string, amount: number): RestletPnlRow =>
  ({ accountId: accountName, accountName, accountType, segment: null, amount });

describe('netsuiteAccountSections', () => {
  it('orients each month like summarizePnl and sums accounts across months', () => {
    const sections = netsuiteAccountSections([
      // Credit-normal month: income reported negative, one contra account positive.
      [ns('Income', 'Sales', -1000), ns('Income', 'Discounts', 100), ns('COGS', 'Materials', 300)],
      [ns('Income', 'Sales', 500), ns('Expense', 'Rent', 200)],
    ]);
    const income = sections.find(s => s.section === 'Income')!;
    expect(income.lines).toEqual([
      { label: 'Sales', amount: 1500 },
      { label: 'Discounts', amount: -100 },
    ]);
    expect(income.total).toBe(1400);
    expect(sections.map(s => s.section)).toEqual(['Income', 'Cost of Goods Sold', 'Expenses']);
  });

  it('ignores balance-sheet types and drops zero lines', () => {
    const sections = netsuiteAccountSections([[ns('Bank', 'Checking', 999), ns('Income', 'Sales', 0)]]);
    expect(sections).toEqual([]);
  });
});

describe('booksAccountSections', () => {
  const account = (id: string, ns: string | null, number: string | null, name: string, type: string): ReportAccount => ({
    id, netsuite_account_id: ns, number, name, account_type: type, statement: 'income_statement', parent_id: null, company: null,
  });
  const entry = (acct: string, month: string, debit: number, credit: number): ReportAmount =>
    ({ account: acct, month, debit: debit.toFixed(2), credit: credit.toFixed(2) });
  // Made-up books: September's and October's sales, a return and a discount, costs, a rent refund in November.
  const data = (): ReportData => ({
    company: 'BMG',
    accounts: [
      account('a10', '10', '1000', 'Checking', 'bank'),
      account('a40', '40', '4000', 'Sales', 'income'),
      account('a41', '41', '4100', 'Discounts', 'income'),
      account('a50', '50', '5000', 'Materials', 'cost_of_goods_sold'),
      account('a65', '65', '6500', 'Rent', 'expense'),
      account('afs', null, null, 'Shop supplies', 'expense'),
      account('a70', '70', '7000', 'Interest income', 'other_income'),
      account('a80', '80', '8000', 'Interest expense', 'other_expense'),
    ],
    opening: [],
    netsuite: [],
    fleetsuite: [
      entry('40', '2026-09-01', 0, 1000),
      entry('40', '2026-10-01', 100, 600),
      entry('41', '2026-10-01', 50, 0),
      entry('50', '2026-10-01', 400, 0),
      entry('65', '2026-10-01', 300, 0),
      entry('65', '2026-11-01', 0, 15),
      entry('fs:afs', '2026-10-01', 25, 0),
      entry('70', '2026-10-01', 0, 20),
      entry('80', '2026-10-01', 10, 0),
      // Not on the profit and loss: the bank, and an account the chart doesn't have yet.
      entry('10', '2026-10-01', 9999, 0),
      entry('99', '2026-10-01', 0, 5),
      entry('40', '2026-12-01', 0, 700),
    ],
  });
  const QUARTER = ['2026-09', '2026-10', '2026-11'];

  it("lists each account's entries over the months, income and costs positive, by number and name", () => {
    expect(booksAccountSections(data(), QUARTER)).toEqual([
      { section: 'Income', total: 1450, lines: [{ label: '4000 Sales', amount: 1500 }, { label: '4100 Discounts', amount: -50 }] },
      { section: 'Cost of Goods Sold', total: 400, lines: [{ label: '5000 Materials', amount: 400 }] },
      { section: 'Expenses', total: 310, lines: [{ label: '6500 Rent', amount: 285 }, { label: 'Shop supplies', amount: 25 }] },
      { section: 'Other Income', total: 20, lines: [{ label: '7000 Interest income', amount: 20 }] },
      { section: 'Other Expenses', total: 10, lines: [{ label: '8000 Interest expense', amount: 10 }] },
    ]);
  });

  it("adds up to the months' totals in the books", () => {
    const sections = booksAccountSections(data(), QUARTER);
    const total = (name: string) => sections.find(s => s.section === name)?.total;
    const pnl = booksPnl(data(), '2026-09-01', '2026-11-01', new Set());
    expect([total('Income'), total('Cost of Goods Sold'), total('Expenses'), total('Other Income'), total('Other Expenses')])
      .toEqual([pnl.income, pnl.cogs, pnl.expense, pnl.otherIncome, pnl.otherExpense]);
  });

  it('counts only the months given, and leaves out an account that nets to nothing', () => {
    expect(booksAccountSections(data(), ['2026-12'])).toEqual([{ section: 'Income', total: 700, lines: [{ label: '4000 Sales', amount: 700 }] }]);
    expect(booksAccountSections(data(), ['2026-11'])).toEqual([{ section: 'Expenses', total: -15, lines: [{ label: '6500 Rent', amount: -15 }] }]);
    expect(booksAccountSections(data(), [])).toEqual([]);
    const books = data();
    books.fleetsuite.push(entry('50', '2026-12-01', 40, 0), entry('50', '2026-12-01', 0, 40));
    expect(booksAccountSections(books, ['2026-12']).map(s => s.section)).toEqual(['Income']);
  });
});

describe('quickbooksAccountSections', () => {
  const report = {
    Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Total' }] },
    Rows: {
      Row: [
        {
          type: 'Section',
          Header: { ColData: [{ value: 'Income' }, { value: '' }] },
          Rows: {
            Row: [
              { type: 'Data', ColData: [{ value: 'Sales', id: '1' }, { value: '900.00' }] },
              {
                type: 'Section',
                Header: { ColData: [{ value: 'Services' }, { value: '' }] },
                Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Install', id: '2' }, { value: '100.00' }] }] },
                Summary: { ColData: [{ value: 'Total Services' }, { value: '100.00' }] },
              },
            ],
          },
          Summary: { ColData: [{ value: 'Total Income' }, { value: '1000.00' }] },
        },
        { group: 'GrossProfit', type: 'Section', Summary: { ColData: [{ value: 'Gross Profit' }, { value: '1000.00' }] } },
      ],
    },
  };

  it('lists leaf accounts with their parent path and never counts totals', () => {
    const [income] = quickbooksAccountSections(report);
    expect(income.section).toBe('Income');
    expect(income.lines).toEqual([
      { label: 'Sales', amount: 900 },
      { label: 'Services › Install', amount: 100 },
    ]);
    expect(income.total).toBe(1000);
  });

  it('survives an empty or missing payload', () => {
    expect(quickbooksAccountSections(null)).toEqual([]);
    expect(quickbooksAccountSections({})).toEqual([]);
  });
});

describe('invoicedByMonth', () => {
  it('adds invoices and sales receipts, subtracts credits, per source and month', () => {
    const m = invoicedByMonth([
      { source: 'netsuite', doc_type: 'invoice', doc_date: '2024-03-04', total: '1000.00' },
      { source: 'netsuite', doc_type: 'credit_memo', doc_date: '2024-03-20', total: 200 },
      { source: 'quickbooks', doc_type: 'sales_receipt', doc_date: '2024-03-02', total: 50 },
      { source: 'quickbooks', doc_type: 'refund_receipt', doc_date: '2024-04-01', total: -20 },
      { source: 'quickbooks', doc_type: 'estimate', doc_date: '2024-03-01', total: 9999 },
    ]);
    expect(m.get('2024-03')).toEqual({ quickbooks: 50, netsuite: 800 });
    expect(m.get('2024-04')).toEqual({ quickbooks: -20, netsuite: 0 });
  });
});
