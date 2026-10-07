import { describe, it, expect } from 'vitest';

import { buildDiscountLines, buildLineDiscountLine, estimateDiscountSplit, estimateNeedsDiscountItem, rankDiscountItems, type DiscountItem } from './discount-item';
import { nsItemLine } from './netsuite';

const discountType: DiscountItem = { id: '901', itemNumber: 'Discount', itemType: 'Discount', source: 'setting' };
const otherCharge: DiscountItem = { id: '902', itemNumber: 'DISCOUNT', itemType: 'OthCharge', source: 'search' };

describe('rankDiscountItems', () => {
  it('prefers real Discount-type items, then the plainest name, then alphabetical', () => {
    const ranked = rankDiscountItems([
      { id: 1, itemid: 'Fleet Discount', itemtype: 'Discount' },
      { id: 2, itemid: 'DISCOUNT', itemtype: 'OthCharge' },
      { id: 3, itemid: 'Discount', itemtype: 'Discount' },
      { id: 4, itemid: 'Promo', itemtype: 'Discount' },
      { id: 5, itemid: 'Bracket', itemtype: 'InvtPart' },
    ]);
    expect(ranked.map(r => r.id)).toEqual([3, 1, 4, 2]);
  });
});

describe('buildDiscountLines', () => {
  const est = { discount_type: 'percent', discount_value: 10, labor_total: 400, vehicle_count: 1 };
  const lines = [
    { quantity: 1, unit_price: 600, taxable: true },
    { quantity: 0, unit_price: 999 },
  ];

  it('sends a taxed line for the share on taxed parts and an untaxed line for the rest', () => {
    // Base 600 + 400 = 1000, 10% = 100: 60 on taxed parts, 40 on labor.
    const out = buildDiscountLines(est, lines, otherCharge);
    expect(out).toEqual([
      { itemId: '902', quantity: 1, rate: -60, description: 'Discount (10%) - on taxed parts', discount: true, taxable: true },
      { itemId: '902', quantity: 1, rate: -40, description: 'Discount (10%) - on labor and untaxed items', discount: true, taxable: false },
    ]);
  });

  it('sends a Discount-type item with no quantity', () => {
    const out = buildDiscountLines({ ...est, labor_total: 0 }, lines, discountType);
    expect(out).toEqual([{ itemId: '901', discountItem: true, rate: -60, description: 'Discount (10%)', discount: true, taxable: true }]);
  });

  it('leaves the taxed share unflagged for a tax-exempt customer', () => {
    const out = buildDiscountLines({ ...est, labor_total: 0, tax_exempt: true }, lines, discountType);
    expect(out[0].taxable).toBeUndefined();
  });

  it('sends nothing when the estimate has no discount', () => {
    expect(buildDiscountLines({ ...est, discount_type: null }, lines, discountType)).toEqual([]);
  });

  it('figures a fleet estimate on the whole order', () => {
    const split = estimateDiscountSplit({ discount_type: 'percent', discount_value: 10, labor_total: 0, vehicle_count: 3 }, [{ quantity: 1, unit_price: 100 }]);
    expect(split.amount).toBe(30);
  });
});

describe('nsItemLine', () => {
  it('leaves ordinary lines exactly as before', () => {
    expect(nsItemLine({ itemId: '5', quantity: 2, rate: 10, description: 'x' }, { pinPrice: true }))
      .toEqual({ item: { id: '5' }, quantity: 2, price: { id: '-1' }, rate: 10, description: 'x' });
    expect(nsItemLine({ itemId: '5', quantity: 2, rate: 0 }, { pinPrice: true }))
      .toEqual({ item: { id: '5' }, quantity: 2 });
    expect(nsItemLine({ itemId: '5', quantity: 2, rate: 10, taxable: false }, { pinPrice: false }))
      .toEqual({ item: { id: '5' }, quantity: 2, rate: 10, isTaxable: false });
  });

  it('keeps a negative discount rate on a sales order, pinned to the Custom price level', () => {
    expect(nsItemLine({ itemId: '902', quantity: 1, rate: -60, discount: true, taxable: true }, { pinPrice: true }))
      .toEqual({ item: { id: '902' }, quantity: 1, price: { id: '-1' }, rate: -60, isTaxable: true });
  });

  it('sends a Discount-type line as the rate alone', () => {
    expect(nsItemLine({ itemId: '901', rate: -40, discount: true, discountItem: true, taxable: false }, { pinPrice: true }))
      .toEqual({ item: { id: '901' }, rate: -40, isTaxable: false });
  });
});

describe('line discount NetSuite lines (migration 350)', () => {
  it('goes under its part with the part\'s tax treatment', () => {
    const taxed = { item_number: 'BRK-1', quantity: 2, unit_price: 100, discount_type: 'percent', discount_value: 10 };
    expect(buildLineDiscountLine(taxed, { vehicle_count: 1 }, otherCharge)).toEqual({
      itemId: '902', quantity: 1, rate: -20, description: 'Discount (10%) - BRK-1', discount: true, taxable: true,
    });
    const untaxed = { ...taxed, taxable: false };
    expect(buildLineDiscountLine(untaxed, { vehicle_count: 1 }, discountType)).toEqual({
      itemId: '901', discountItem: true, rate: -20, description: 'Discount (10%) - BRK-1', discount: true, taxable: false,
    });
    expect(buildLineDiscountLine(taxed, { vehicle_count: 1, tax_exempt: true }, otherCharge)?.taxable).toBeUndefined();
    expect(buildLineDiscountLine({ quantity: 1, unit_price: 10 }, {}, otherCharge)).toBeNull();
  });

  it('the whole-job discount spreads over what is left after line discounts', () => {
    const lines = [{ quantity: 1, unit_price: 500, discount_type: 'amount', discount_value: 100 }];
    expect(estimateDiscountSplit({ discount_type: 'percent', discount_value: 10, labor_total: 0 }, lines).amount).toBe(40);
  });

  it('knows when an estimate needs the discount item at all', () => {
    expect(estimateNeedsDiscountItem({}, [{ quantity: 1, unit_price: 10 }])).toBe(0);
    expect(estimateNeedsDiscountItem({}, [{ quantity: 1, unit_price: 10, discount_type: 'amount', discount_value: 2 }])).toBe(2);
    expect(estimateNeedsDiscountItem({ discount_type: 'amount', discount_value: 5 }, [{ quantity: 1, unit_price: 10 }])).toBe(5);
  });
});
