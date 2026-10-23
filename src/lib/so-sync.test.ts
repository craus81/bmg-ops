import { describe, it, expect } from 'vitest';
import { soContentHash, untaxedFlag, zeroPriceLines, zeroPriceLinesError } from './so-sync';

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

describe('soContentHash and line discounts (migration 350)', () => {
  const estimate = { labor_hours: 0, labor_rate: 120, estimate_number: 'EST-1', vin: '' };
  const line = { item_number: 'A', quantity: 1, unit_price: 100, sort_order: 0 };
  it('a line with no discount hashes exactly as before', () => {
    expect(soContentHash(estimate, [{ ...line, discount_type: null, discount_value: null }])).toBe(soContentHash(estimate, [line]));
  });
  it('adding a line discount marks the sales order out of date', () => {
    expect(soContentHash(estimate, [{ ...line, discount_type: 'percent', discount_value: 5 }])).not.toBe(soContentHash(estimate, [line]));
  });
});

describe('zeroPriceLines (Convert to SO / Push to SO stop on these)', () => {
  it('names priced-at-$0 lines with nothing behind them, in estimate order', () => {
    expect(zeroPriceLines([
      { sort_order: 2, item_number: 'N5-RS48', description: 'Shelf', quantity: 1, unit_price: '0' },
      { sort_order: 1, item_number: 'CC600', description: 'Cab', quantity: 1, unit_price: 125 },
      { sort_order: 0, item_number: '', description: 'Custom bracket', quantity: 2, unit_price: null },
    ])).toEqual(['Custom bracket', 'N5-RS48 — Shelf']);
  });

  it('lets through qty-0 "included" lines and $0 lines carrying labor hours', () => {
    expect(zeroPriceLines([
      { item_number: 'X', quantity: 0, unit_price: 0 },
      { description: 'Rack — assembly labor', quantity: 1, unit_price: 0, labor_hours: 1.5 },
    ])).toEqual([]);
  });

  it('reads plainly for one line or several', () => {
    expect(zeroPriceLinesError(['A'], 'No sales order was created.'))
      .toBe('This line has no price: A. Set a price on the estimate (or remove the line), then try again. No sales order was created.');
    expect(zeroPriceLinesError(['A', 'B'], 'x')).toMatch(/^These lines have no price: A; B\./);
  });
});
