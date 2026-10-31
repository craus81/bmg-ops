import { describe, it, expect } from 'vitest';
import { canAddToPo, oldestAddableDate, planPoLineAdds, memoWithSos } from './po-add';
import type { PoItemLine } from './netsuite';

const line = (l: Partial<PoItemLine> & { line: number; itemId: string }): PoItemLine => ({
  quantity: 1, quantityReceived: 0, quantityBilled: 0, isClosed: false, rate: null, description: null, ...l,
});

// 2026-10-30 10:00 in St. Louis.
const now = new Date('2026-10-30T15:00:00Z');

describe('canAddToPo', () => {
  it('takes an open PO dated today or yesterday', () => {
    expect(oldestAddableDate(now)).toBe('2026-10-29');
    expect(canAddToPo({ status: 'B', trandate: '2026-10-30' }, now)).toBe(true);
    expect(canAddToPo({ status: 'B', trandate: '2026-10-29' }, now)).toBe(true);
    expect(canAddToPo({ status: null, trandate: '2026-10-29' }, now)).toBe(true);
  });

  it('refuses a PO 2 days old or more', () => {
    expect(canAddToPo({ status: 'B', trandate: '2026-10-28' }, now)).toBe(false);
  });

  it('refuses received and closed POs', () => {
    for (const status of ['F', 'G', 'C', 'H']) {
      expect(canAddToPo({ status, trandate: '2026-10-30' }, now)).toBe(false);
    }
  });

  it('uses shop time, not UTC, for today', () => {
    // 2026-10-31 02:00 UTC is still 10-30 in St. Louis.
    expect(oldestAddableDate(new Date('2026-10-31T02:00:00Z'))).toBe('2026-10-29');
  });

  it('crosses a month end', () => {
    expect(oldestAddableDate(new Date('2026-11-01T15:00:00Z'))).toBe('2026-10-31');
  });
});

describe('planPoLineAdds', () => {
  it('raises the qty of a part already on the PO', () => {
    const plan = planPoLineAdds([line({ line: 3, itemId: '100', quantity: 1 })], [
      { itemId: '100', quantity: 1, rate: 24.1, description: null },
    ]);
    expect(plan.lines).toEqual([{ line: 3, quantity: 2 }]);
    expect(plan.raised.get('100')).toEqual({ from: 1, to: 2 });
    expect(plan.added).toEqual([]);
  });

  it('adds a new line for a part not on the PO', () => {
    const plan = planPoLineAdds([line({ line: 1, itemId: '100' })], [
      { itemId: '200', quantity: 2, rate: 38.95, description: 'Harness' },
    ]);
    expect(plan.lines).toEqual([{ item: { id: '200' }, quantity: 2, rate: 38.95, description: 'Harness' }]);
    expect(plan.added).toEqual(['200']);
  });

  it('leaves the rate to NetSuite when none is given', () => {
    const plan = planPoLineAdds([], [{ itemId: '200', quantity: 2, rate: null, description: null }]);
    expect(plan.lines).toEqual([{ item: { id: '200' }, quantity: 2 }]);
  });

  it('adds a second line when the existing one was partly received or is closed', () => {
    const plan = planPoLineAdds([
      line({ line: 1, itemId: '100', quantity: 4, quantityReceived: 1 }),
      line({ line: 2, itemId: '200', quantity: 2, isClosed: true }),
    ], [
      { itemId: '100', quantity: 1, rate: null, description: null },
      { itemId: '200', quantity: 1, rate: null, description: null },
    ]);
    expect(plan.lines).toEqual([{ item: { id: '100' }, quantity: 1 }, { item: { id: '200' }, quantity: 1 }]);
    expect(plan.raised.size).toBe(0);
  });

  it('never adds a generic part (Misc) onto another of its lines', () => {
    const plan = planPoLineAdds([line({ line: 1, itemId: '900', quantity: 2 })], [
      { itemId: '900', quantity: 3, rate: 18.5, description: 'Rivets', separate: true },
      { itemId: '900', quantity: 1, rate: null, description: 'Bracket', separate: true },
    ]);
    expect(plan.lines).toEqual([
      { item: { id: '900' }, quantity: 3, rate: 18.5, description: 'Rivets' },
      { item: { id: '900' }, quantity: 1, description: 'Bracket' },
    ]);
    expect(plan.raised.size).toBe(0);
  });
});

describe('memoWithSos', () => {
  it('adds only the sales orders the memo does not name', () => {
    expect(memoWithSos('FleetSuite purchase requests — for SO 1192', ['1192', '1201']))
      .toBe('FleetSuite purchase requests — for SO 1192 · SO 1201');
  });

  it('returns null when nothing changes', () => {
    expect(memoWithSos('for SO 1192', ['1192'])).toBeNull();
    expect(memoWithSos('Stock order', [])).toBeNull();
  });

  it('does not treat a longer SO number as a match', () => {
    expect(memoWithSos('for SO 11920', ['1192'])).toBe('for SO 11920 · SO 1192');
  });
});
