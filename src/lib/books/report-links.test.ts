import { describe, it, expect } from 'vitest';
import { detailMonths } from './report-links';

const range = { from: '2026-03-01', to: '2026-10-01', first: '2025-01-01' };
const gaps = (...months: string[]) => months.map((month) => ({ month, difference: 100 }));

describe('the months a line on Reports opens its detail on', () => {
  it("covers the profit and loss's months, a trial balance income line's year to date, else the report's month", () => {
    expect(detailMonths('profit_and_loss', {}, range)).toEqual({ from: '2026-03-01', to: '2026-10-01' });
    expect(detailMonths('balance_sheet', {}, range)).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(detailMonths('trial_balance', {}, range)).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(detailMonths('trial_balance', { yearToDate: true }, range)).toEqual({ from: '2026-01-01', to: '2026-10-01' });
  });

  it('starts a line that differs at the first month it differs in, when that is earlier', () => {
    // A balance carries a difference from December 2025 into October 2026.
    expect(detailMonths('balance_sheet', { months: gaps('2025-12-01', '2026-03-01') }, range))
      .toEqual({ from: '2025-12-01', to: '2026-10-01' });
    expect(detailMonths('trial_balance', { months: gaps('2025-12-01') }, range)).toEqual({ from: '2025-12-01', to: '2026-10-01' });
    // A difference that started in the line's own months changes nothing.
    expect(detailMonths('balance_sheet', { months: gaps('2026-10-01') }, range)).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(detailMonths('profit_and_loss', { months: gaps('2026-04-01', '2026-09-01') }, range))
      .toEqual({ from: '2026-03-01', to: '2026-10-01' });
    expect(detailMonths('trial_balance', { yearToDate: true, months: gaps('2026-02-01') }, range))
      .toEqual({ from: '2026-01-01', to: '2026-10-01' });
  });

  it("never starts before the reports' first month", () => {
    expect(detailMonths('balance_sheet', { months: gaps('2024-12-01', '2025-06-01') }, range)).toEqual({ from: '2025-01-01', to: '2026-10-01' });
  });
});
