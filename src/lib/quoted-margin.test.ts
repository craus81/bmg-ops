import { describe, it, expect } from 'vitest';
import { computeQuotedMargin, type QuotedMarginLine } from './quoted-margin';

const line = (over: Partial<QuotedMarginLine>): QuotedMarginLine => ({
  item_number: 'PART-1', quantity: 1, unit_price: 100,
  purchase_price: 40, avg_install_cost: 10, ...over,
});

describe('computeQuotedMargin — the frozen twin of the builder strip', () => {
  it('parts margin over costed lines: cost = purchase + install, per unit x qty', () => {
    const m = computeQuotedMargin([
      line({ quantity: 2, unit_price: 100 }), // cost 50/unit → 100 cost, 200 revenue
      line({ item_number: 'PART-2', unit_price: 60, purchase_price: 30, avg_install_cost: null }), // 30 cost, 60 rev
    ], 0, null);
    expect(m.costTotal).toBe(130);
    expect(m.costedRevenue).toBe(260);
    expect(m.marginPct).toBe(50);
    expect(m.uncostedCount).toBe(0);
  });

  it('uncosted lines (custom, no cost fields) are excluded and counted — never 100% margin', () => {
    const m = computeQuotedMargin([
      line({}),
      line({ item_number: null, purchase_price: null, avg_install_cost: null, unit_price: 500 }),
    ], 0, null);
    expect(m.uncostedCount).toBe(1);
    expect(m.costedRevenue).toBe(100); // the 500 uncosted line is not revenue in the %
    expect(m.marginPct).toBe(50);
    expect(m.lines[1]).toMatchObject({ unit_cost: null, margin_pct: null });
  });

  it('a zero-cost part that HAS a cost field is a real 100% margin, not uncosted', () => {
    const m = computeQuotedMargin([
      line({ purchase_price: 0, avg_install_cost: null, unit_price: 80 }),
    ], 0, null);
    expect(m.uncostedCount).toBe(0);
    expect(m.marginPct).toBe(100);
  });

  it('all lines uncosted → marginPct null, not 100', () => {
    const m = computeQuotedMargin([
      line({ purchase_price: null, avg_install_cost: null }),
    ], 0, null);
    expect(m.marginPct).toBeNull();
  });

  it('negative margin (selling below cost) comes out negative', () => {
    const m = computeQuotedMargin([line({ unit_price: 40, purchase_price: 45, avg_install_cost: 5 })], 0, null);
    expect(m.marginPct).toBe(-25);
  });

  it('labor cost = sold hours x blended rate; null rate = null (parts-only margin)', () => {
    expect(computeQuotedMargin([line({})], 6, 42.5).laborCost).toBe(255);
    expect(computeQuotedMargin([line({})], 6, null).laborCost).toBeNull();
  });
});
