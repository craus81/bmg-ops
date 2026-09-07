import { describe, it, expect } from 'vitest';
import { chicagoDay, unbilledLineValue } from './exec-metrics';

describe('chicagoDay — snapshots key on shop days, not UTC days', () => {
  it('late-evening Chicago time is still the same Chicago day past the UTC rollover', () => {
    // 2026-09-08T04:30:00Z = 2026-09-07 23:30 CDT — the cron's slot.
    expect(chicagoDay(new Date('2026-09-08T04:30:00Z'))).toBe('2026-09-07');
    // Winter (CST, UTC-6): 2026-12-10T04:30:00Z = 2026-12-09 22:30 CST.
    expect(chicagoDay(new Date('2026-12-10T04:30:00Z'))).toBe('2026-12-09');
  });

  it('daytime maps straight through', () => {
    expect(chicagoDay(new Date('2026-09-07T18:00:00Z'))).toBe('2026-09-07');
  });
});

describe('unbilledLineValue — sold-but-uninvoiced dollars per mirrored SO line', () => {
  it('scales the real amount by the unbilled fraction (amount carries discounts)', () => {
    expect(unbilledLineValue({ quantity: 10, quantity_billed: 4, rate: 100, amount: 900 })).toBeCloseTo(540); // 900 × 6/10
    expect(unbilledLineValue({ quantity: 2, quantity_billed: 0, rate: 50, amount: 100 })).toBe(100);
  });

  it('falls back to remaining × rate when amount is missing', () => {
    expect(unbilledLineValue({ quantity: 3, quantity_billed: 1, rate: 25, amount: null })).toBe(50);
  });

  it('fully billed and over-billed lines are zero, never negative', () => {
    expect(unbilledLineValue({ quantity: 5, quantity_billed: 5, rate: 10, amount: 50 })).toBe(0);
    expect(unbilledLineValue({ quantity: 5, quantity_billed: 7, rate: 10, amount: 50 })).toBe(0);
  });

  it('numeric-string columns (PostgREST NUMERIC) parse correctly', () => {
    expect(unbilledLineValue({ quantity: '4', quantity_billed: '1', rate: '12.5', amount: null })).toBeCloseTo(37.5);
  });
});
