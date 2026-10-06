import { describe, it, expect } from 'vitest';
import { soContentHash, untaxedFlag } from './so-sync';

describe('soContentHash and line taxability', () => {
  const estimate = { labor_hours: 2, labor_rate: 115, estimate_number: 'EST-1', vin: '1FT' };
  const lines = [{ item_number: 'A', quantity: 1, unit_price: 10, sort_order: 0 }];

  it('is unchanged for lines saved before migration 336 or stamped taxed', () => {
    const before = soContentHash(estimate, lines);
    expect(soContentHash(estimate, lines.map(l => ({ ...l, taxable: null })))).toBe(before);
    expect(soContentHash(estimate, lines.map(l => ({ ...l, taxable: true })))).toBe(before);
  });

  it('changes when a line becomes untaxed, so the sales order is flagged out of date', () => {
    expect(soContentHash(estimate, lines.map(l => ({ ...l, taxable: false }))))
      .not.toBe(soContentHash(estimate, lines));
  });

  it('carries only an explicit false', () => {
    expect(untaxedFlag({ taxable: false })).toEqual({ taxable: false });
    expect(untaxedFlag({ taxable: null })).toEqual({});
    expect(untaxedFlag({})).toEqual({});
  });
});

describe('soContentHash and the estimate discount (migration 342)', () => {
  const estimate = { labor_hours: 2, labor_rate: 120, estimate_number: 'EST-1', vin: '' };
  const lines = [{ item_number: 'A', quantity: 1, unit_price: 100, sort_order: 0 }];

  it('an estimate with no discount hashes exactly as before', () => {
    expect(soContentHash({ ...estimate, discount_type: null, discount_value: null }, lines)).toBe(soContentHash(estimate, lines));
  });

  it('adding or changing a discount marks the sales order out of date', () => {
    const plain = soContentHash(estimate, lines);
    const tenPct = soContentHash({ ...estimate, discount_type: 'percent', discount_value: 10 }, lines);
    const twelvePct = soContentHash({ ...estimate, discount_type: 'percent', discount_value: 12 }, lines);
    expect(tenPct).not.toBe(plain);
    expect(twelvePct).not.toBe(tenPct);
  });
});
