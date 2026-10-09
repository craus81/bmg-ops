import { describe, expect, it } from 'vitest';
import { parseFinalPrice, parseRateMap, readPricingOverrides, scaleQuoteSnapshot } from './wrap-quote-price-override';
import { wrapQuoteDocModel } from './wrap-quote-document';

const snap = {
  measurements: [
    { name: 'Hood', qty: 1, billed_area_sqft: 20, unit_price: 200, line_total: 200, substrate: { id: 'f1', name: 'Cast', price_per_sqft: 10 } },
    { name: 'Door', qty: 2, billed_area_sqft: 10, unit_price: 100, line_total: 200, substrate: { id: 'f1', name: 'Cast', price_per_sqft: 10 } },
  ],
  labor: {
    design: { flat: 100, total: 100 },
    preparation: { flat: 0, total: 0 },
    installation: { flat: 0, total: 0 },
    films: [{ id: 'f1', label: 'Cast', sqft: 40, rate: 5, total: 200 }],
  },
  nesting: null,
  adjustments: null,
  package_qty: 1,
  subtotal: 1050,
  tax_rate: 0,
  tax_amount: 0,
  total: 1050,
};

describe('scaleQuoteSnapshot', () => {
  it('scales every customer-visible money row so the lines add up to the final price', () => {
    // Calculated 700 → typed 1050.
    const out = scaleQuoteSnapshot(snap, 1050 / 700);
    const lines = out.measurements.reduce((s: number, l: any) => s + l.line_total, 0);
    const labor = out.labor.films[0].total + out.labor.design.total;
    expect(lines + labor).toBeCloseTo(1050, 6);
    expect(out.measurements[0].unit_price).toBeCloseTo(300, 6);
    expect(out.measurements[1].substrate.price_per_sqft).toBeCloseTo(15, 6);
    expect(out.labor.films[0].rate).toBeCloseTo(7.5, 6);
    // Sizes and quantities never move.
    expect(out.measurements[1].qty).toBe(2);
    expect(out.measurements[0].billed_area_sqft).toBe(20);
  });

  it('keeps roll-priced shape lines blank and scales the roll material rows', () => {
    const rolled = {
      ...snap,
      measurements: snap.measurements.map(l => ({ ...l, unit_price: null, line_total: null })),
      nesting: { enabled: true, films: [{ film_id: 'f1', rate_per_sqft: 10, material_total: 400 }] },
    };
    const out = scaleQuoteSnapshot(rolled, 2);
    expect(out.measurements[0].unit_price).toBeNull();
    expect(out.nesting.films[0].material_total).toBe(800);
  });

  it('scales the kit rollup but leaves no discount or minimum rows showing', () => {
    const kits = { ...snap, adjustments: { kit_materials: 400, pre_materials: 1600, pre_labor: 300, pre_subtotal: 1900, discount_amount: 0, min_bump: 0 } };
    const out = scaleQuoteSnapshot(kits, 0.5);
    expect(out.adjustments.pre_materials).toBe(800);
    const doc = wrapQuoteDocModel({ ...out, package_qty: 4 }, { pricing: true, lineItems: true });
    expect(JSON.stringify(doc)).not.toContain('Quantity discount');
    expect(JSON.stringify(doc)).not.toContain('Subtotal before adjustments');
  });

  it('is a no-op at a factor of 1 or a bad factor', () => {
    expect(scaleQuoteSnapshot(snap, 1)).toBe(snap);
    expect(scaleQuoteSnapshot(snap, 0)).toBe(snap);
    expect(scaleQuoteSnapshot(snap, NaN)).toBe(snap);
  });
});

describe('override parsing', () => {
  it('reads the typed final price', () => {
    expect(parseFinalPrice('')).toBeNull();
    expect(parseFinalPrice('  ')).toBeNull();
    expect(parseFinalPrice('0')).toBeNull();
    expect(parseFinalPrice('abc')).toBeNull();
    expect(parseFinalPrice('2500')).toBe(2500);
  });

  it('drops blank and junk rates', () => {
    expect(parseRateMap({ a: '', b: '7.5', c: 'x', d: '-1', e: '0' })).toEqual({ b: 7.5, e: 0 });
  });

  it('round-trips saved overrides and tolerates older rows', () => {
    expect(readPricingOverrides(null)).toBeNull();
    expect(readPricingOverrides({ final_price: 1200, vinyl_rates: { f1: 9 }, labor_rates: { f1: '4' }, discount_pct: '5' })).toEqual({
      final_price: 1200, vinyl_rates: { f1: 9 }, labor_rates: { f1: 4 }, discount_pct: '5',
    });
    expect(readPricingOverrides({ final_price: null })).toEqual({ final_price: null, vinyl_rates: {}, labor_rates: {}, discount_pct: '' });
  });
});
