import { describe, it, expect } from 'vitest';
import { computeTotals, roundCentsHalfEven } from './estimate-totals';

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

// Per-item taxability (migration 252) and NetSuite-identical rounding.
//
// EST-2608-024, reproduced line for line from the NetSuite estimate EST942
// it was pushed to. Two things made the quote disagree with the invoice:
// Freight is non-taxable in NetSuite, and NetSuite books tax per line with
// half-cent ties going to the even cent. Both are pinned here — if this
// fails, a customer is signing a total we won't bill.
describe('computeTotals — EST-2608-024 against NetSuite EST942', () => {
  const lines = [
    { quantity: 4, unit_price: 697.50, labor_hours: 0 }, // 5010 — exactly $221.805 of tax
    { quantity: 1, unit_price: 182.70, labor_hours: 0 }, // 5048
    { quantity: 1, unit_price: 81.00, labor_hours: 0 },  // 5014
    { quantity: 2, unit_price: 44.47, labor_hours: 0 },  // 202991
    { quantity: 1, unit_price: 595.97, labor_hours: 0 }, // 256500
    { quantity: 1, unit_price: 63.14, labor_hours: 0 },  // 202003
    { quantity: 1, unit_price: 94.73, labor_hours: 0 },  // 202999
    { quantity: 1, unit_price: 150.00, labor_hours: 0, taxable: false }, // Freight
  ];

  it('matches the NetSuite invoice to the penny', () => {
    const r = computeTotals(lines, 0.0795, false, 115, 4.5);
    expect(r.subtotal).toBe(4046.48);
    expect(r.labor_total).toBe(517.5);
    expect(r.tax_amount).toBe(309.76);   // NetSuite EST942
    expect(r.grand_total).toBe(4873.74); // NetSuite EST942
  });

  it('taxing the combined base instead would be a cent high', () => {
    // The pre-fix arithmetic, kept as the contrast: 3896.48 × 7.95% rounds
    // to 309.77, and per-line booking is what makes it 309.76.
    expect(roundCentsHalfEven(3896.48 * 0.0795)).toBe(309.77);
  });

  it('still taxes freight when NetSuite has not said otherwise', () => {
    const r = computeTotals(lines.map(({ taxable, ...l }) => l), 0.0795, false, 115, 4.5);
    // 309.76 + 11.92 — the freight line's own tax is a tie too ($11.925),
    // so it books down as well. Slightly under the $321.70 the builder used
    // to show, because that taxed the combined base in one go.
    expect(r.tax_amount).toBe(321.68);
  });

  it('tax-exempt still wins over everything', () => {
    expect(computeTotals(lines, 0.0795, true, 115, 4.5).tax_amount).toBe(0);
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

// The tie rule is the whole reason the totals matched NetSuite, and float
// error is what makes it easy to get wrong.
describe('roundCentsHalfEven', () => {
  it('sends an exact half-cent to the even cent, both directions', () => {
    expect(roundCentsHalfEven(221.805)).toBe(221.8);  // 22180 is even — down
    expect(roundCentsHalfEven(221.815)).toBe(221.82); // 22181 is odd — up
    expect(roundCentsHalfEven(0.005)).toBe(0);
    expect(roundCentsHalfEven(0.015)).toBe(0.02);
  });

  it('survives the float representation of a tie', () => {
    // 2790 × 0.0795 is 221.80500000000000682 in IEEE754; a naive === 0.5
    // tie test misses it and rounds up, which is the cent that started this.
    expect(roundCentsHalfEven(2790 * 0.0795)).toBe(221.8);
  });

  it('rounds normally when there is no tie', () => {
    expect(roundCentsHalfEven(6.4395)).toBe(6.44);
    expect(roundCentsHalfEven(14.52465)).toBe(14.52);
    expect(roundCentsHalfEven(47.379615)).toBe(47.38);
    expect(roundCentsHalfEven(0)).toBe(0);
  });
});
