import { describe, it, expect } from 'vitest';
import { computeReorderSuggestion, weeklyVelocity } from './reorder';

describe('computeReorderSuggestion — min/max trigger', () => {
  it('does not trigger while cover is above the point', () => {
    expect(computeReorderSuggestion({ reorderPoint: 5, orderUpTo: 20, free: 4, onOrder: 2, pendingRequested: 0 }))
      .toEqual({ triggered: false, suggestedQty: 0 });
  });

  it('triggers at exactly the point and fills to order_up_to', () => {
    expect(computeReorderSuggestion({ reorderPoint: 5, orderUpTo: 20, free: 3, onOrder: 2, pendingRequested: 0 }))
      .toEqual({ triggered: true, suggestedQty: 15 });
  });

  it('counts pending requests toward the fill so it never double-queues', () => {
    expect(computeReorderSuggestion({ reorderPoint: 5, orderUpTo: 20, free: 0, onOrder: 0, pendingRequested: 20 }))
      .toEqual({ triggered: true, suggestedQty: 0 });
    expect(computeReorderSuggestion({ reorderPoint: 5, orderUpTo: 20, free: 2, onOrder: 0, pendingRequested: 12 }))
      .toEqual({ triggered: true, suggestedQty: 6 });
  });

  it('order_up_to below the point (or null) falls back to the point', () => {
    expect(computeReorderSuggestion({ reorderPoint: 10, orderUpTo: 4, free: 1, onOrder: 0, pendingRequested: 0 }))
      .toEqual({ triggered: true, suggestedQty: 9 });
    expect(computeReorderSuggestion({ reorderPoint: 10, orderUpTo: null, free: 1, onOrder: 0, pendingRequested: 0 }))
      .toEqual({ triggered: true, suggestedQty: 9 });
  });

  it('rounds fractional gaps up to whole units', () => {
    expect(computeReorderSuggestion({ reorderPoint: 5, orderUpTo: 10, free: 2.5, onOrder: 0, pendingRequested: 0 }))
      .toEqual({ triggered: true, suggestedQty: 8 });
  });
});

describe('weeklyVelocity', () => {
  it('converts a 90-day count to installs per week', () => {
    expect(weeklyVelocity(90)).toBe(7);
    expect(weeklyVelocity(13)).toBe(1);
    expect(weeklyVelocity(0)).toBe(0);
  });
});
