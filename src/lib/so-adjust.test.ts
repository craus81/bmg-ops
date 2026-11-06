import { describe, expect, it } from 'vitest';
import type { SoLine } from './sales-order-edit';
import { adjustLineProblem, buildAdjustEdit, startDrafts } from './so-adjust';

const line = (over: Partial<SoLine>): SoLine => ({
  line: 1, itemId: '10', itemNumber: 'VINYL', itemType: 'InvtPart', description: 'Vinyl',
  quantity: 2, quantityShipped: 0, quantityBilled: 0, rate: 50, amount: 100, isClosed: false, editable: true,
  ...over,
});

describe('buildAdjustEdit', () => {
  it('sends nothing when nothing changed', () => {
    const lines = [line({}), line({ line: 2, itemNumber: 'LABOR', rate: 95, quantity: 3, amount: 285 })];
    const e = buildAdjustEdit(lines, startDrafts(lines), [], true);
    expect(e.count).toBe(0);
    expect(e.errors).toEqual([]);
    expect(e.subtotal).toBe(385);
  });

  it('sends a longer removal and more vinyl, and re-prices the subtotal', () => {
    const lines = [line({}), line({ line: 2, itemNumber: 'LABOR', rate: 95, quantity: 3, amount: 285 })];
    const d = startDrafts(lines);
    d[1].quantity = '3';
    d[2].quantity = '4.5';
    d[2].rate = '100';
    const e = buildAdjustEdit(lines, d, [], true);
    expect(e.lines).toEqual([{ line: 1, quantity: 3 }, { line: 2, quantity: 4.5, rate: 100 }]);
    expect(e.subtotal).toBe(600);
  });

  it('adds new lines and checks them', () => {
    const lines = [line({})];
    const e = buildAdjustEdit(lines, startDrafts(lines), [
      { key: 1, itemId: '77', itemNumber: 'REMOVAL', description: 'Removal', quantityText: '1', rateText: '150' },
      { key: 2, itemId: '78', itemNumber: 'BAD', description: '', quantityText: '0', rateText: '5' },
    ], true);
    expect(e.add).toEqual([{ itemId: '77', itemNumber: 'REMOVAL', description: 'Removal', quantity: 1, rate: 150 }]);
    expect(e.errors).toEqual(['BAD: enter a quantity.']);
    expect(e.subtotal).toBe(250);
  });

  it('keeps quantity at or above what shipped, and leaves billed prices alone', () => {
    const l = line({ quantity: 4, quantityShipped: 3, quantityBilled: 1, amount: 200 });
    const d = startDrafts([l]);
    d[1].quantity = '2';
    d[1].rate = '60';
    expect(adjustLineProblem(l, d[1])).toBe('3 already shipped');
    const e = buildAdjustEdit([l], d, [], true);
    expect(e.errors).toEqual(['VINYL: 3 already shipped.']);
    expect(e.lines).toEqual([]);
  });

  it('never sends a price for someone who cannot see prices', () => {
    const lines = [line({})];
    const d = startDrafts(lines);
    d[1].rate = '1';
    expect(buildAdjustEdit(lines, d, [], false).count).toBe(0);
  });

  it('skips fully billed and non-item lines', () => {
    const lines = [
      line({ quantityBilled: 2, quantityShipped: 2 }),
      line({ line: 2, editable: false, itemNumber: 'Discount', rate: null, amount: -10 }),
    ];
    const d = startDrafts(lines);
    d[1].quantity = '9';
    const e = buildAdjustEdit(lines, d, [], true);
    expect(e.count).toBe(0);
    expect(e.subtotal).toBe(90);
  });
});
