import { describe, it, expect } from 'vitest';
import { classifyCloseBucket, summarizeDealForecast, daysPast, type ForecastDeal } from './deal-forecast';

describe('classifyCloseBucket', () => {
  const today = '2026-09-08';
  it('buckets by calendar month; a close date of today is still this_month', () => {
    expect(classifyCloseBucket('2026-09-08', today)).toBe('this_month');
    expect(classifyCloseBucket('2026-09-30', today)).toBe('this_month');
    expect(classifyCloseBucket('2026-09-07', today)).toBe('overdue');
    expect(classifyCloseBucket('2026-10-01', today)).toBe('next_month');
    expect(classifyCloseBucket('2026-11-01', today)).toBe('later');
    expect(classifyCloseBucket(null, today)).toBe('undated');
  });
  it('December rolls next_month into January of the next year', () => {
    expect(classifyCloseBucket('2027-01-15', '2026-12-20')).toBe('next_month');
    expect(classifyCloseBucket('2027-02-01', '2026-12-20')).toBe('later');
  });
});

describe('summarizeDealForecast', () => {
  const deal = (id: string, expectedClose: string | null, value: number): ForecastDeal => ({
    id, prospectId: 'p1', title: `Deal ${id}`, stage: 'quoted', value,
    expectedClose, customer: 'Acme', createdBy: null,
  });

  it('totals per column and sorts soonest-close first', () => {
    const f = summarizeDealForecast([
      deal('a', '2026-09-20', 5000),
      deal('b', '2026-09-10', 3000),
      deal('c', '2026-08-30', 7000), // overdue
      deal('d', '2026-10-05', 2000),
      deal('e', null, 1000),
    ], '2026-09-08');
    expect(f.thisMonth).toMatchObject({ count: 2, value: 8000 });
    expect(f.thisMonth.deals.map(d => d.id)).toEqual(['b', 'a']);
    expect(f.overdue).toMatchObject({ count: 1, value: 7000 });
    expect(f.nextMonth).toMatchObject({ count: 1, value: 2000 });
    expect(f.undated).toMatchObject({ count: 1, value: 1000 });
    expect(f.later.count).toBe(0);
  });
});

describe('daysPast', () => {
  it('positive when the second day is later, across months', () => {
    expect(daysPast('2026-08-30', '2026-09-08')).toBe(9);
    expect(daysPast('2026-09-08', '2026-09-08')).toBe(0);
  });
});
