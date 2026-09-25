import { describe, it, expect } from 'vitest';
import { monthBounds, monthsBetween, netsuiteMonthStale, nsSummaryToMonth, qboSummaryToMonth, yearTotals } from './financial-history';

describe('monthsBetween / monthBounds', () => {
  it('walks across a year boundary inclusively', () => {
    expect(monthsBetween('2023-11', '2024-02')).toEqual(['2023-11', '2023-12', '2024-01', '2024-02']);
    expect(monthsBetween('2024-03', '2024-03')).toEqual(['2024-03']);
    expect(monthsBetween('2024-04', '2024-03')).toEqual([]);
  });

  it('knows month ends, leap years included', () => {
    expect(monthBounds('2024-02')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(monthBounds('2023-02')).toEqual({ start: '2023-02-01', end: '2023-02-28' });
    expect(monthBounds('2023-12').end).toBe('2023-12-31');
  });
});

describe('qboSummaryToMonth', () => {
  it('maps the QuickBooks summary labels and derives other income/expense', () => {
    const m = qboSummaryToMonth('2021-06', {
      'Total Income': 100000, 'Total Cost of Goods Sold': 40000, 'Gross Profit': 60000,
      'Total Expenses': 45000, 'Net Income': 16000,
    });
    expect(m).toMatchObject({ month: '2021-06', source: 'quickbooks', income: 100000, cogs: 40000, grossProfit: 60000, expenses: 45000, netIncome: 16000, otherNet: 1000, directional: false });
  });

  it('treats totals QuickBooks left out as zero, not as missing money', () => {
    const m = qboSummaryToMonth('2019-01', { 'Total Income': 5000, 'Total Expenses': 2000, 'Net Income': 3000 });
    expect(m.cogs).toBe(0);
    expect(m.grossProfit).toBe(5000);
    expect(m.otherNet).toBe(0);
    expect(qboSummaryToMonth('2019-02', {})).toMatchObject({ income: 0, netIncome: 0 });
    expect(qboSummaryToMonth('2019-03', null).income).toBe(0);
  });
});

describe('nsSummaryToMonth', () => {
  it('folds payroll back into expenses so both systems mean the same thing', () => {
    const m = nsSummaryToMonth('2025-01', {
      income: 200000, cogs: 90000, expense: 50000, payroll: 30000, otherIncome: 500, otherExpense: 1500,
      grossMargin: 110000, grossMarginPct: 55, netProfit: 29000, netProfitPct: 14.5, laborPct: 15, accountCount: 40,
    }, false);
    expect(m).toMatchObject({ source: 'netsuite', income: 200000, grossProfit: 110000, expenses: 80000, otherNet: -1000, netIncome: 29000 });
  });
});

describe('yearTotals', () => {
  it('sums months per year and reports coverage and sources', () => {
    const months = [
      qboSummaryToMonth('2023-11', { 'Total Income': 100, 'Net Income': 10 }),
      qboSummaryToMonth('2023-12', { 'Total Income': 300, 'Net Income': 30 }),
      nsSummaryToMonth('2024-01', { income: 400, cogs: 100, expense: 100, payroll: 100, otherIncome: 0, otherExpense: 0, grossMargin: 300, grossMarginPct: 75, netProfit: 100, netProfitPct: 25, laborPct: 25, accountCount: 3 }, true),
    ];
    const [y23, y24] = yearTotals(months);
    expect(y23).toMatchObject({ year: 2023, income: 400, netIncome: 40, months: 2, sources: ['quickbooks'], netMarginPct: 10, directional: false });
    expect(y24).toMatchObject({ year: 2024, income: 400, grossMarginPct: 75, sources: ['netsuite'], directional: true });
  });

  it('gives no margin for a year with no revenue', () => {
    expect(yearTotals([qboSummaryToMonth('2018-01', {})])[0].grossMarginPct).toBeNull();
  });
});

describe('netsuiteMonthStale', () => {
  it('refetches a month copied before its books could have closed', () => {
    expect(netsuiteMonthStale('2025-01', null)).toBe(true);
    expect(netsuiteMonthStale('2025-01', '2025-02-05T00:00:00Z')).toBe(true);
    expect(netsuiteMonthStale('2025-01', '2025-04-01T00:00:00Z')).toBe(false);
  });
});
