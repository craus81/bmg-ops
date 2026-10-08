import { describe, it, expect } from 'vitest';
import { computeTotals, discountLabel, discountSplit, lineDiscountColumns, lineMoney, netUnitPrice, normalizeDiscount, roundCentsHalfEven, normalizeVehicleCount } from './estimate-totals';

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
      discount_amount: 0,
      discount_taxed: 0,
      line_discount_total: 0,
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
      discount_amount: 0,
      discount_taxed: 0,
      line_discount_total: 0,
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
      discount_amount: 0,
      discount_taxed: 0,
      line_discount_total: 0,
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

// NetSuite-identical rounding, and the removal of per-item taxability.
//
// EST-2608-024, reproduced line for line from the NetSuite estimate EST942
// it was pushed to. NetSuite books tax per line with half-cent ties going to
// the even cent, which is pinned here — if this fails, a customer is signing
// a total we will not bill.
//
// A line stamped `taxable: false` is left out of the tax. The stamp comes
// from FleetSuite's own rule (migration 336: Service items and freight
// untaxed, admin override per part), never from NetSuite's unmaintained item
// Taxable box, so these cases pin the math, not where the flag comes from.
describe('computeTotals — EST-2608-024 against NetSuite EST942', () => {
  const lines = [
    { quantity: 4, unit_price: 697.50, labor_hours: 0 }, // 5010 — exactly $221.805 of tax
    { quantity: 1, unit_price: 182.70, labor_hours: 0 }, // 5048
    { quantity: 1, unit_price: 81.00, labor_hours: 0 },  // 5014
    { quantity: 2, unit_price: 44.47, labor_hours: 0 },  // 202991
    { quantity: 1, unit_price: 595.97, labor_hours: 0 }, // 256500
    { quantity: 1, unit_price: 63.14, labor_hours: 0 },  // 202003
    { quantity: 1, unit_price: 94.73, labor_hours: 0 },  // 202999
    { quantity: 1, unit_price: 150.00, labor_hours: 0 }, // Freight
  ];
  const freightUntaxed = lines.map((l, i) => (i === lines.length - 1 ? { ...l, taxable: false } : l));

  it('books tax per line, ties to the even cent', () => {
    const r = computeTotals(lines, 0.0795, false, 115, 4.5);
    expect(r.subtotal).toBe(4046.48);
    expect(r.labor_total).toBe(517.5);
    // 309.76 across the seven part lines + 11.92 on freight (its $11.925 is
    // a tie too, so it books down). Per-line booking is the point: taxing
    // the combined base in one go gives a different, wrong figure.
    expect(r.tax_amount).toBe(321.68);
    expect(r.grand_total).toBe(4885.66);
  });

  it('taxing the combined base instead would be a cent high', () => {
    // The pre-fix arithmetic, kept as the contrast: the seven part lines
    // come to 3896.48, and 3896.48 × 7.95% rounds to 309.77 in one go while
    // per-line booking makes it 309.76.
    expect(roundCentsHalfEven(3896.48 * 0.0795)).toBe(309.77);
  });

  it('tax-exempt still wins over everything', () => {
    expect(computeTotals(lines, 0.0795, true, 115, 4.5).tax_amount).toBe(0);
  });

  it('untaxed freight lands on exactly what NetSuite billed for EST942', () => {
    // NetSuite left the $150 freight out and billed $309.76; with freight
    // stamped non-taxable the quote now agrees to the penny.
    const r = computeTotals(freightUntaxed, 0.0795, false, 115, 4.5);
    expect(r.tax_amount).toBe(309.76);
    expect(r.subtotal).toBe(4046.48); // the line still bills, just untaxed
    expect(r.grand_total).toBe(4873.74);
  });

  it('only an explicit false leaves a line out', () => {
    const mixed = [
      { quantity: 1, unit_price: 100, labor_hours: 0 },
      { quantity: 1, unit_price: 100, labor_hours: 0, taxable: null },
      { quantity: 1, unit_price: 100, labor_hours: 0, taxable: undefined },
      { quantity: 1, unit_price: 100, labor_hours: 0, taxable: true },
      { quantity: 1, unit_price: 100, labor_hours: 0, taxable: false },
    ];
    // null/undefined are lines saved before migration 336, quoted as taxed.
    expect(computeTotals(mixed, 0.1, false, 0, 0).tax_amount).toBe(40);
  });

  it('labor is still never taxed', () => {
    const r = computeTotals(
      [{ quantity: 2, unit_price: 75, labor_hours: 3 }],
      0.0795, false, 115, null,
    );
    expect(r.subtotal).toBe(150);
    expect(r.labor_total).toBe(690);
    expect(r.tax_amount).toBe(11.92); // 150 × 7.95% = 11.925, a tie → even cent
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

// ── Fleet multi-unit (R6-9, migration 304) ────────────────────────────────
describe('vehicle count', () => {
  const line = (over = {}) => ({ quantity: 2, unit_price: 100, labor_hours: 1.5, ...over });

  it('an absent count changes NOTHING — every estimate ever written is count 1', () => {
    const lines = [line(), line({ quantity: 1, unit_price: 49.99 })];
    const before = computeTotals(lines, 0.0795, false, 85, null);
    const explicit = computeTotals(lines, 0.0795, false, 85, null, 1);
    expect(explicit).toEqual(before);
  });

  it('multiplies line quantities, so the subtotal scales exactly', () => {
    const t = computeTotals([line()], 0, true, 85, null, 12);
    // 2 units × $100 × 12 vehicles
    expect(t.subtotal).toBe(2400);
  });

  it('multiplies auto labor hours the same way', () => {
    const t = computeTotals([line()], 0, true, 85, null, 12);
    // 1.5h per unit × 2 units × 12 vehicles
    expect(t.labor_hours).toBe(36);
    expect(t.labor_total).toBe(36 * 85);
  });

  it('treats a labor override as the JOB total, not a per-vehicle figure', () => {
    // The field already meant "hours for this job" and still does — every
    // downstream reader (SO push, labor burn, quoted margin) depends on it.
    const t = computeTotals([line()], 0, true, 85, 10, 12);
    expect(t.labor_total).toBe(850);
  });

  it('taxes the FLEET quantity per line, not the single-vehicle tax times N', () => {
    // The distinction this whole design turns on. One line, qty 1 @ $697.50,
    // 7.95%: single-vehicle tax rounds to $55.45 (55.45125), so ×4 would be
    // $221.80 — while NetSuite bills 4 units as one line and books
    // round(221.805) = $221.80 too. Either way the ANSWER must come from the
    // fleet amount, which is what is asserted here.
    const t = computeTotals([{ quantity: 1, unit_price: 697.5, labor_hours: 0 }], 0.0795, false, 85, null, 4);
    expect(t.tax_amount).toBe(roundCentsHalfEven(697.5 * 4 * 0.0795));
    expect(t.subtotal).toBe(2790);
  });

  it('leaves an untaxed line out at any count, and still taxes the rest', () => {
    const t = computeTotals(
      [
        { quantity: 1, unit_price: 500, labor_hours: 0 },
        { quantity: 1, unit_price: 200, labor_hours: 0, taxable: false },
      ],
      0.0795, false, 85, null, 10,
    );
    expect(t.tax_amount).toBe(397.5); // 5000 × 7.95%; the 2000 service is untaxed
    expect(t.subtotal).toBe(7000);
  });

  it('honours tax exemption at any count', () => {
    expect(computeTotals([line()], 0.0795, true, 85, null, 7).tax_amount).toBe(0);
  });
});

describe('normalizeVehicleCount', () => {
  it('keeps a real count', () => {
    expect(normalizeVehicleCount(12)).toBe(12);
    expect(normalizeVehicleCount('12')).toBe(12);
  });

  it('floors a fractional count — there is no half a van', () => {
    expect(normalizeVehicleCount(2.9)).toBe(2);
  });

  it('falls back to 1 for anything that is not a count, never 0', () => {
    // A zero would silently zero out an entire estimate.
    expect(normalizeVehicleCount(0)).toBe(1);
    expect(normalizeVehicleCount(-5)).toBe(1);
    expect(normalizeVehicleCount(null)).toBe(1);
    expect(normalizeVehicleCount(undefined)).toBe(1);
    expect(normalizeVehicleCount('many')).toBe(1);
    expect(normalizeVehicleCount(NaN)).toBe(1);
  });
});

describe('estimate discount (migration 342)', () => {
  const lines = [
    { quantity: 2, unit_price: 100, labor_hours: 1.5 },
    { quantity: 1, unit_price: 50, labor_hours: 0.5 },
  ];

  it('takes a percent off the whole job (parts + labor) before tax', () => {
    // Base 250 parts + 332.50 labor = 582.50; 10% = 58.25. The taxed share is
    // 250/582.50 of it = 25.00, which lowers the tax by 25 x 8% = 2.00.
    expect(computeTotals(lines, 0.08, false, 95, null, 1, { type: 'percent', value: 10 })).toEqual({
      subtotal: 250,
      labor_hours: 3.5,
      labor_total: 332.5,
      discount_amount: 58.25,
      discount_taxed: 25,
      line_discount_total: 0,
      tax_amount: 18,
      grand_total: 542.25,
    });
  });

  it('takes a dollar amount off, split by taxed and untaxed dollars', () => {
    const r = computeTotals(
      [{ quantity: 1, unit_price: 600 }, { quantity: 1, unit_price: 400, taxable: false }],
      0.1, false, 0, null, 1, { type: 'amount', value: 100 },
    );
    expect(r.discount_amount).toBe(100);
    expect(r.discount_taxed).toBe(60);
    expect(r.tax_amount).toBe(54); // 60 - 6
    expect(r.grand_total).toBe(954); // 1000 - 100 + 54
  });

  it('never takes the job below zero', () => {
    const r = computeTotals([{ quantity: 1, unit_price: 50 }], 0.1, false, 0, null, 1, { type: 'amount', value: 500 });
    expect(r.discount_amount).toBe(50);
    expect(r.tax_amount).toBe(0);
    expect(r.grand_total).toBe(0);
  });

  it('a tax-exempt customer still gets the discount and no tax', () => {
    const r = computeTotals(lines, 0.08, true, 95, null, 1, { type: 'percent', value: 10 });
    expect(r.tax_amount).toBe(0);
    expect(r.grand_total).toBe(524.25);
  });

  it('a dollar discount on a fleet estimate is for the whole order', () => {
    const one = computeTotals([{ quantity: 1, unit_price: 100 }], 0, false, 0, null, 3, { type: 'amount', value: 30 });
    expect(one.subtotal).toBe(300);
    expect(one.grand_total).toBe(270);
  });

  it('no discount leaves every figure exactly as before', () => {
    const plain = computeTotals(lines, 0.0795, false, 120, null);
    const none = computeTotals(lines, 0.0795, false, 120, null, 1, null);
    expect(none).toEqual(plain);
  });
});

describe('normalizeDiscount', () => {
  it('reads what the builder or a row sends', () => {
    expect(normalizeDiscount('percent', '12.5')).toEqual({ type: 'percent', value: 12.5 });
    expect(normalizeDiscount('amount', 250)).toEqual({ type: 'amount', value: 250 });
  });
  it('treats blank, zero, negative and unknown types as no discount', () => {
    expect(normalizeDiscount('percent', '')).toBeNull();
    expect(normalizeDiscount('percent', 0)).toBeNull();
    expect(normalizeDiscount('amount', -5)).toBeNull();
    expect(normalizeDiscount(null, 10)).toBeNull();
    expect(normalizeDiscount('bogus', 10)).toBeNull();
  });
  it('caps a percent at 100', () => {
    expect(normalizeDiscount('percent', 150)).toEqual({ type: 'percent', value: 100 });
  });
});

describe('discountSplit', () => {
  it('rounds a percent to the cent and keeps the two shares summing to the whole', () => {
    const s = discountSplit(333.33, 111.11, { type: 'percent', value: 7 });
    expect(s.amount).toBe(23.33);
    expect(Math.round((s.taxedPortion + s.untaxedPortion) * 100) / 100).toBe(23.33);
  });
  it('is all untaxed when nothing on the job is taxed', () => {
    expect(discountSplit(500, 0, { type: 'amount', value: 50 })).toEqual({ amount: 50, taxedPortion: 0, untaxedPortion: 50 });
  });
});

describe('discountLabel', () => {
  it('names the percent, not a dollar amount', () => {
    expect(discountLabel('percent', 10)).toBe('Discount (10%)');
    expect(discountLabel('percent', '12.5')).toBe('Discount (12.5%)');
    expect(discountLabel('amount', 250)).toBe('Discount');
  });
});

describe('line discount (migration 350)', () => {
  it('takes a percent or dollars off one line, capped at the line', () => {
    expect(lineMoney({ quantity: 2, unit_price: 100, discount_type: 'percent', discount_value: 10 })).toEqual({ gross: 200, discount: 20, net: 180 });
    expect(lineMoney({ quantity: 2, unit_price: 100, discount_type: 'amount', discount_value: 25 })).toEqual({ gross: 200, discount: 25, net: 175 });
    expect(lineMoney({ quantity: 1, unit_price: 10, discount_type: 'amount', discount_value: 25 })).toEqual({ gross: 10, discount: 10, net: 0 });
    expect(lineMoney({ quantity: 1, unit_price: 10 })).toEqual({ gross: 10, discount: 0, net: 10 });
  });

  it('a dollar line discount on a fleet estimate is for the whole line, all vehicles', () => {
    expect(lineMoney({ quantity: 1, unit_price: 100, discount_type: 'amount', discount_value: 30 }, 3)).toEqual({ gross: 300, discount: 30, net: 270 });
    expect(lineMoney({ quantity: 1, unit_price: 100, discount_type: 'percent', discount_value: 10 }, 3).discount).toBe(30);
  });

  it('comes off the subtotal and lowers that line\'s tax only', () => {
    const r = computeTotals([
      { quantity: 1, unit_price: 500, discount_type: 'percent', discount_value: 20 }, // taxed: 400 net
      { quantity: 1, unit_price: 100, taxable: false, discount_type: 'amount', discount_value: 10 }, // untaxed: 90 net
    ], 0.1, false, 0, null);
    expect(r.subtotal).toBe(490);
    expect(r.line_discount_total).toBe(110);
    expect(r.tax_amount).toBe(40); // 50 - 10, nothing from the untaxed line
    expect(r.grand_total).toBe(530);
  });

  it('the whole-job discount applies after line discounts', () => {
    const r = computeTotals(
      [{ quantity: 1, unit_price: 500, discount_type: 'percent', discount_value: 20 }],
      0, false, 0, null, 1, { type: 'percent', value: 10 },
    );
    expect(r.subtotal).toBe(400);
    expect(r.discount_amount).toBe(40);
    expect(r.grand_total).toBe(360);
  });

  it('stores the columns and nets the unit price for margins', () => {
    const l = { quantity: 4, unit_price: 50, discount_type: 'percent', discount_value: '25' };
    expect(lineDiscountColumns(l)).toEqual({ discount_type: 'percent', discount_value: 25, discount_amount: 50 });
    expect(lineDiscountColumns({ quantity: 1, unit_price: 5 })).toEqual({ discount_type: null, discount_value: null, discount_amount: 0 });
    expect(netUnitPrice(l)).toBe(37.5);
  });
});
