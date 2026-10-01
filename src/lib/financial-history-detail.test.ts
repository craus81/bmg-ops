import { describe, it, expect } from 'vitest';
import { invoicedByMonth, netsuiteAccountSections, quickbooksAccountSections } from './financial-history-detail';
import type { RestletPnlRow } from './netsuite';

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
