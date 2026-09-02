import { describe, it, expect } from 'vitest';
import { computeTotals } from './estimate-totals';

// Characterization tests: these lock in the production behavior of the
// estimate money math. If one of these fails, pricing changed — make sure
// that was intentional before updating the expectation.
//
// Aug 2026, with sign-off: per-line labor is now labor_hours × quantity,
// matching the builder UI. The expectations below were updated deliberately
// (labor on the 2×1.5h line is 3h, not 1.5h).
describe('computeTotals', () => {
  const lines = [
    { quantity: 2, unit_price: 100, labor_hours: 1.5 },
    { quantity: 1, unit_price: 50, labor_hours: 0.5 },
  ];

  it('computes subtotal, labor, and tax on a typical estimate', () => {
    expect(computeTotals(lines, 0.08, false, 95, null)).toEqual({
      subtotal: 250,
      labor_hours: 3.5, // 1.5h × qty 2 + 0.5h × qty 1
      labor_total: 332.5,
      tax_amount: 20,
      grand_total: 602.5,
    });
  });

  it('multiplies per-line labor hours by quantity, matching the builder', () => {
    const result = computeTotals(
      [{ quantity: 4, unit_price: 10, labor_hours: 0.5 }],
      0, true, 100, null
    );
    expect(result.labor_hours).toBe(2); // 0.5h each × 4 units
    expect(result.labor_total).toBe(200);
  });

  it('taxes parts only, never labor', () => {
    const result = computeTotals(lines, 0.08, false, 95, null);
    // tax = 8% of the 250 subtotal; the 332.50 of labor is untaxed
    expect(result.tax_amount).toBe(20);
  });

  it('zeroes tax when tax-exempt', () => {
    expect(computeTotals(lines, 0.08, true, 95, null)).toEqual({
      subtotal: 250,
      labor_hours: 3.5,
      labor_total: 332.5,
      tax_amount: 0,
      grand_total: 582.5,
    });
  });

  it('labor override replaces the per-line sum, but labor_hours still reports the per-line sum', () => {
    const result = computeTotals(lines, 0.08, false, 95, 10);
    expect(result.labor_total).toBe(950);
    expect(result.labor_hours).toBe(3.5); // reported hours are the auto sum, not the override
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
    expect(result.labor_hours).toBe(0.75); // 0.25h × qty 3
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

// Per-item taxability (migration 252). The live case: NetSuite treats
// Freight as non-taxable, FleetSuite taxed it, and the customer signed a
// total $11.94 above what NetSuite billed.
describe('computeTotals — non-taxable lines', () => {
  const parts = [
    { quantity: 1, unit_price: 3896.48, labor_hours: 0 },
    { quantity: 1, unit_price: 150, labor_hours: 0, taxable: false }, // Freight
  ];

  it('excludes a non-taxable line from the tax base but not the subtotal', () => {
    const r = computeTotals(parts, 0.0795, false, 115, 4.5);
    expect(r.subtotal).toBe(4046.48);
    // 3896.48 × 7.95% — the freight is not in the base.
    expect(r.tax_amount).toBe(309.77);
    expect(r.labor_total).toBe(517.5);
    expect(r.grand_total).toBe(4873.75);
  });

  it('taxes the same lines in full when nothing is flagged', () => {
    const r = computeTotals(parts.map(({ taxable, ...l }) => l), 0.0795, false, 115, 4.5);
    // 4046.48 × 7.95% — the pre-252 figure, still what unknown items get,
    // and exactly the $321.70 the builder showed on EST-2608-024.
    expect(r.tax_amount).toBe(321.7);
  });

  it('only an explicit false excludes — unknown stays taxable', () => {
    const unknown = [
      { quantity: 1, unit_price: 100, labor_hours: 0 },
      { quantity: 1, unit_price: 100, labor_hours: 0, taxable: null },
      { quantity: 1, unit_price: 100, labor_hours: 0, taxable: undefined },
      { quantity: 1, unit_price: 100, labor_hours: 0, taxable: true },
    ];
    expect(computeTotals(unknown, 0.1, false, 0, 0).tax_amount).toBe(40);
  });

  it('tax-exempt still wins over everything', () => {
    expect(computeTotals(parts, 0.0795, true, 115, 4.5).tax_amount).toBe(0);
  });

  it('an all-non-taxable estimate has no tax but keeps its subtotal', () => {
    const r = computeTotals(
      [{ quantity: 2, unit_price: 75, labor_hours: 0, taxable: false }],
      0.0795, false, 115, 0,
    );
    expect(r.subtotal).toBe(150);
    expect(r.tax_amount).toBe(0);
    expect(r.grand_total).toBe(150);
  });
});
