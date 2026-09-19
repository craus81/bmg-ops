import { describe, it, expect } from 'vitest';
import { summarizePnl, payrollAccountIds, pnlPeriodDefs, isPnlPeriodKey, PNL_PERIOD_KEYS } from './pnl';
import type { RestletPnlRow } from './netsuite';

const row = (accountType: string, amount: number, accountId = 'a'): RestletPnlRow => ({
  accountId, accountName: accountId, accountType, segment: null, amount,
});

describe('summarizePnl — orientation-robust P&L buckets', () => {
  it('credit-normal input (income negative, costs positive) normalizes to positive magnitudes', () => {
    const s = summarizePnl([
      row('Income', -100000),
      row('COGS', 40000),
      row('Expense', 25000, 'op'),
      row('Expense', 10000, 'pay'),
    ], new Set(['pay']));
    expect(s.income).toBe(100000);
    expect(s.cogs).toBe(40000);
    expect(s.expense).toBe(25000);
    expect(s.payroll).toBe(10000);
    expect(s.grossMargin).toBe(60000);
    expect(s.grossMarginPct).toBe(60);
    expect(s.netProfit).toBe(25000);
    expect(s.netProfitPct).toBe(25);
    expect(s.laborPct).toBe(10);
  });

  it('report-normal input (everything positive) gives the same answer', () => {
    const s = summarizePnl([
      row('Income', 100000),
      row('COGS', 40000),
      row('Expense', 35000, 'op'),
    ], new Set());
    expect(s.income).toBe(100000);
    expect(s.grossMarginPct).toBe(60);
    expect(s.netProfit).toBe(25000);
  });

  it('contra accounts keep their relative sign inside a bucket', () => {
    const s = summarizePnl([
      row('Income', -100000, 'sales'),
      row('Income', 5000, 'refunds'), // contra-income shrinks revenue
      row('COGS', 30000),
    ], new Set());
    expect(s.income).toBe(95000);
    expect(s.cogs).toBe(30000);
    expect(s.grossMargin).toBe(65000);
  });

  it('other income/expense fold into net profit only', () => {
    const s = summarizePnl([
      row('Income', -100), row('COGS', 40),
      row('OthIncome', -10), row('OthExpense', 5),
    ], new Set());
    expect(s.grossMargin).toBe(60);
    expect(s.netProfit).toBe(65); // 100 - 40 + 10 - 5
  });

  it('no income → percentage fields null, never divide-by-zero', () => {
    const s = summarizePnl([row('Expense', 500)], new Set());
    expect(s.grossMarginPct).toBeNull();
    expect(s.netProfitPct).toBeNull();
    expect(s.laborPct).toBeNull();
  });
});

describe('payrollAccountIds', () => {
  it('parses the env list and drops junk', () => {
    expect([...payrollAccountIds('101, 202 ,abc,')].sort()).toEqual(['101', '202']);
    expect(payrollAccountIds('').size).toBe(0);
  });
});

describe('pnlPeriodDefs — selectable ranges (fiscal year = calendar year)', () => {
  const d = pnlPeriodDefs('2026-09-19');

  it('last month is the whole previous month, and closed', () => {
    expect(d['last-month'].from).toBe('2026-08-01');
    expect(d['last-month'].to).toBe('2026-08-31');
    expect(d['last-month'].directional).toBe(false);
  });

  it('periods containing today are directional', () => {
    expect(d['mtd']).toMatchObject({ from: '2026-09-01', to: '2026-09-19', directional: true });
    expect(d['qtd']).toMatchObject({ from: '2026-07-01', to: '2026-09-19', directional: true });
    expect(d['ytd']).toMatchObject({ from: '2026-01-01', to: '2026-09-19', directional: true });
  });

  it('last year is the full prior calendar year, and closed', () => {
    expect(d['last-year']).toMatchObject({ from: '2025-01-01', to: '2025-12-31', directional: false });
  });

  it('rolls the year over in January', () => {
    const jan = pnlPeriodDefs('2026-01-07');
    expect(jan['last-month']).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(jan['last-year']).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('every advertised key has a definition', () => {
    for (const k of PNL_PERIOD_KEYS) expect(d[k].key).toBe(k);
  });
});

describe('isPnlPeriodKey', () => {
  it('accepts the known keys and rejects anything else', () => {
    expect(isPnlPeriodKey('ytd')).toBe(true);
    expect(isPnlPeriodKey('last-year')).toBe(true);
    expect(isPnlPeriodKey('all-time')).toBe(false);
    expect(isPnlPeriodKey(undefined)).toBe(false);
  });
});
