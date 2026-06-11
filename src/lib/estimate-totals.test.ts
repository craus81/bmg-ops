import { describe, it, expect } from 'vitest';
import { computeTotals } from './estimate-totals';

// Characterization tests: these lock in the production behavior of the
// estimate money math. If one of these fails, pricing changed — make sure
// that was intentional before updating the expectation.
describe('computeTotals', () => {
  const lines = [
    { quantity: 2, unit_price: 100, labor_hours: 1.5 },
    { quantity: 1, unit_price: 50, labor_hours: 0.5 },
  ];

  it('computes subtotal, labor, and tax on a typical estimate', () => {
    expect(computeTotals(lines, 0.08, false, 95, null)).toEqual({
      subtotal: 250,
      labor_hours: 2,
      labor_total: 190,
      tax_amount: 20,
      grand_total: 460,
    });
  });

  it('taxes parts only, never labor', () => {
    const result = computeTotals(lines, 0.08, false, 95, null);
    // tax = 8% of the 250 subtotal; the 190 of labor is untaxed
    expect(result.tax_amount).toBe(20);
  });

  it('zeroes tax when tax-exempt', () => {
    expect(computeTotals(lines, 0.08, true, 95, null)).toEqual({
      subtotal: 250,
      labor_hours: 2,
      labor_total: 190,
      tax_amount: 0,
      grand_total: 440,
    });
  });

  it('labor override replaces the per-line sum, but labor_hours still reports the per-line sum', () => {
    const result = computeTotals(lines, 0.08, false, 95, 10);
    expect(result.labor_total).toBe(950);
    expect(result.labor_hours).toBe(2); // reported hours are the auto sum, not the override
    expect(result.grand_total).toBe(1220);
  });

  it('a labor override of 0 is respected (not treated as missing)', () => {
    const result = computeTotals(lines, 0.08, false, 95, 0);
    expect(result.labor_total).toBe(0);
    expect(result.grand_total).toBe(270);
  });

  it('accepts string quantities and prices (as sent by the quote UI)', () => {
    const result = computeTotals(
      [{ quantity: '3', unit_price: '19.99', labor_hours: '0.25' }],
      0, true, 95, null
    );
    expect(result.subtotal).toBe(59.97);
    expect(result.labor_hours).toBe(0.25);
  });

  it('rounds each figure to cents', () => {
    // 3 × 33.333 = 99.999 → 100.00; tax 7.5% of 99.999 = 7.4999… → 7.5
    const result = computeTotals(
      [{ quantity: 3, unit_price: 33.333 }],
      0.075, false, 0, null
    );
    expect(result.subtotal).toBe(100);
    expect(result.tax_amount).toBe(7.5);
    expect(result.grand_total).toBe(107.5);
  });

  it('handles an empty estimate', () => {
    expect(computeTotals([], 0.08, false, 95, null)).toEqual({
      subtotal: 0,
      labor_hours: 0,
      labor_total: 0,
      tax_amount: 0,
      grand_total: 0,
    });
  });

  it('treats missing line fields as zero', () => {
    const result = computeTotals([{ quantity: 2 }, { unit_price: 10 }], 0.08, false, 95, null);
    expect(result.subtotal).toBe(0);
    expect(result.grand_total).toBe(0);
  });

  it('supports negative quantities (credit lines)', () => {
    const result = computeTotals(
      [
        { quantity: 1, unit_price: 500 },
        { quantity: -1, unit_price: 100 },
      ],
      0.1, false, 0, null
    );
    expect(result.subtotal).toBe(400);
    expect(result.tax_amount).toBe(40);
    expect(result.grand_total).toBe(440);
  });
});
