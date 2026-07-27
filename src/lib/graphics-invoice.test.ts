import { describe, it, expect } from 'vitest';
import { kitLineSplit } from './graphics-invoice';

// The split must ALWAYS reconstruct the total exactly: quantity × rate is
// what NetSuite books, and a penny of drift desyncs the estimate/invoice
// from the quote the customer approved.
describe('kitLineSplit', () => {
  it('splits into qty × per-kit rate when cents divide exactly', () => {
    expect(kitLineSplit(11760, 12)).toEqual({ quantity: 12, rate: 980 });
    expect(kitLineSplit(10584, 12)).toEqual({ quantity: 12, rate: 882 });
    expect(kitLineSplit(1.5, 3)).toEqual({ quantity: 3, rate: 0.5 });
  });

  it('falls back to a single line when the split would not be cent-exact', () => {
    expect(kitLineSplit(100, 3)).toEqual({ quantity: 1, rate: 100 });
    expect(kitLineSplit(45.5, 4)).toEqual({ quantity: 1, rate: 45.5 });
  });

  it('reconstructs the total exactly in both branches', () => {
    for (const [total, qty] of [[11760, 12], [100, 3], [4500.25, 7], [882.36, 12], [45, 1]] as const) {
      const { quantity, rate } = kitLineSplit(total, qty);
      expect(Math.round(quantity * rate * 100)).toBe(Math.round(total * 100));
    }
  });

  it('treats qty ≤ 1, fractional, and garbage quantities as a single line', () => {
    expect(kitLineSplit(500, 1)).toEqual({ quantity: 1, rate: 500 });
    expect(kitLineSplit(500, 0)).toEqual({ quantity: 1, rate: 500 });
    expect(kitLineSplit(500, NaN)).toEqual({ quantity: 1, rate: 500 });
    // 2.9 floors to 2; 500 splits evenly into 2 × 250
    expect(kitLineSplit(500, 2.9)).toEqual({ quantity: 2, rate: 250 });
  });

  it('rounds float noise in the total before deciding divisibility', () => {
    // 0.1 + 0.2 style noise: 117.60000000000001 × 100 → rounds to 11760 cents
    expect(kitLineSplit(117.60000000000001, 12)).toEqual({ quantity: 12, rate: 9.8 });
  });
});
