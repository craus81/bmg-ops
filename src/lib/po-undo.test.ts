import { describe, it, expect } from 'vitest';
import { planPoLineUndo, isCreatedPoOrder } from './po-undo';
import type { PoItemLine } from './netsuite';

const line = (l: Partial<PoItemLine> & { line: number; itemId: string }): PoItemLine => ({
  quantity: 1, quantityReceived: 0, quantityBilled: 0, isClosed: false, rate: null, description: null, ...l,
});

describe('planPoLineUndo', () => {
  it('removes the part and keeps every other line as it is', () => {
    const plan = planPoLineUndo([
      line({ line: 1, itemId: '100', quantity: 4 }),
      line({ line: 2, itemId: '200', quantity: 2 }),
    ], '100', 4, 'EX-1');
    expect(plan).toEqual({ kind: 'patch', replace: true, lines: [{ line: 2 }], closesPo: false });
  });

  it('only lowers the quantity when other requests still need the part', () => {
    const plan = planPoLineUndo([line({ line: 1, itemId: '100', quantity: 6 })], '100', 4, 'EX-1');
    expect(plan).toEqual({ kind: 'patch', replace: false, lines: [{ line: 1, quantity: 2 }], closesPo: false });
  });

  it('closes the PO instead of leaving it with no lines', () => {
    const plan = planPoLineUndo([line({ line: 1, itemId: '100', quantity: 4 })], '100', 4, 'EX-1');
    expect(plan).toEqual({ kind: 'patch', replace: false, lines: [{ line: 1, isClosed: true }], closesPo: true });
  });

  it('keeps already-closed lines when the part is removed', () => {
    const plan = planPoLineUndo([
      line({ line: 1, itemId: '100', quantity: 4 }),
      line({ line: 2, itemId: '200', quantity: 2, isClosed: true }),
    ], '100', 4, 'EX-1');
    expect(plan).toEqual({ kind: 'patch', replace: true, lines: [{ line: 2 }], closesPo: true });
  });

  it('refuses once anything was received or billed', () => {
    const plan = planPoLineUndo([line({ line: 1, itemId: '100', quantity: 4, quantityReceived: 1 })], '100', 4, 'EX-1');
    expect(plan.kind).toBe('refuse');
    expect((plan as any).error).toContain('EX-1');
  });

  it('changes nothing in NetSuite when the part is already off the PO', () => {
    expect(planPoLineUndo([line({ line: 2, itemId: '200' })], '100', 4, 'EX-1')).toEqual({ kind: 'gone' });
    expect(planPoLineUndo([line({ line: 1, itemId: '100', isClosed: true }), line({ line: 2, itemId: '200' })], '100', 4, 'EX-1')).toEqual({ kind: 'gone' });
  });

  it('takes from the biggest line first when the part is on two lines', () => {
    const plan = planPoLineUndo([
      line({ line: 1, itemId: '100', quantity: 2 }),
      line({ line: 2, itemId: '100', quantity: 5 }),
      line({ line: 3, itemId: '300', quantity: 1 }),
    ], '100', 6, 'EX-1');
    expect(plan).toEqual({ kind: 'patch', replace: true, lines: [{ line: 1, quantity: 1 }, { line: 3 }], closesPo: false });
  });
});

describe('isCreatedPoOrder', () => {
  it('is only rows ordered by Create PO', () => {
    expect(isCreatedPoOrder({ status: 'ordered', ordered_match: null, ordered_po_id: 'x' })).toBe(true);
    expect(isCreatedPoOrder({ status: 'ordered', ordered_match: 'auto', ordered_po_id: 'x' })).toBe(false);
    expect(isCreatedPoOrder({ status: 'ordered', ordered_match: 'manual', ordered_po_id: 'x' })).toBe(false);
    expect(isCreatedPoOrder({ status: 'pending', ordered_match: null, ordered_po_id: null })).toBe(false);
  });
});
