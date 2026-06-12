import { describe, it, expect } from 'vitest';
import { splitAmounts } from './pay-credits';

const m = (profile_id: string, share_weight = 1) => ({ profile_id, share_weight });

describe('splitAmounts', () => {
  it('splits evenly across the crew', () => {
    const out = splitAmounts(100, [m('a'), m('b'), m('c'), m('d')]);
    expect(out.map(o => o.amount)).toEqual([25, 25, 25, 25]);
  });

  it('always sums exactly to the rate (rounding remainder lands on the first member)', () => {
    const out = splitAmounts(100, [m('a'), m('b'), m('c')]);
    expect(out.reduce((s, o) => s + (o.amount || 0), 0)).toBeCloseTo(100, 10);
    expect(out.map(o => o.amount)).toEqual([33.34, 33.33, 33.33]);
  });

  it('honors uneven share weights', () => {
    const out = splitAmounts(100, [m('lead', 2), m('helper'), m('helper2')]);
    expect(out.map(o => o.amount)).toEqual([50, 25, 25]);
  });

  it('handles fractional weights and awkward rates without losing cents', () => {
    const out = splitAmounts(99.99, [m('a', 1.5), m('b', 1), m('c', 1)]);
    const total = out.reduce((s, o) => s + Math.round((o.amount || 0) * 100), 0);
    expect(total).toBe(9999);
  });

  it('solo crew takes the full rate', () => {
    expect(splitAmounts(87.5, [m('a')])[0].amount).toBe(87.5);
  });

  it('null rate (unpriced part) yields null amounts but keeps the members', () => {
    const out = splitAmounts(null, [m('a'), m('b')]);
    expect(out).toHaveLength(2);
    expect(out.every(o => o.amount === null)).toBe(true);
  });

  it('empty crew yields no rows', () => {
    expect(splitAmounts(100, [])).toEqual([]);
  });
});
