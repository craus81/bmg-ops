import { describe, it, expect } from 'vitest';
import { orderAgeDays, summarizeOrderBook, type OrderBookRow } from './order-book';

const row = (over: Partial<OrderBookRow>): OrderBookRow => ({
  id: 'x', netsuiteId: '1', tranid: 'SO1', customerName: 'C', trandate: '2026-09-01',
  statusLabel: 'Pending Fulfillment', total: 0, unbilled: 0, billedPct: 0, ageDays: 0,
  ...over,
});

describe('orderAgeDays', () => {
  it('counts whole days from the transaction date, never negative', () => {
    const now = new Date('2026-09-07T18:00:00Z');
    expect(orderAgeDays('2026-09-01', now)).toBe(6);
    expect(orderAgeDays('2026-09-07', now)).toBe(0);
    expect(orderAgeDays('2026-09-30', now)).toBe(0); // future-dated SO clamps
    expect(orderAgeDays(null, now)).toBe(0);
    expect(orderAgeDays('not-a-date', now)).toBe(0);
  });
});

describe('summarizeOrderBook', () => {
  it('totals value/unbilled, buckets aging by order value, counts over-60s', () => {
    const totals = summarizeOrderBook([
      row({ total: 1000, unbilled: 600, ageDays: 10 }),
      row({ total: 500, unbilled: 500, ageDays: 45 }),
      row({ total: 200, unbilled: 0, ageDays: 61 }),
      row({ total: 300, unbilled: 100, ageDays: 120 }),
    ]);
    expect(totals.count).toBe(4);
    expect(totals.value).toBe(2000);
    expect(totals.unbilled).toBe(1200);
    expect(totals.over60Count).toBe(2);
    expect(totals.aging).toEqual({ d0_30: 1000, d31_60: 500, d61_90: 200, d90plus: 300 });
  });

  it('is exact at the bucket boundaries (30/60/90)', () => {
    const totals = summarizeOrderBook([
      row({ total: 1, ageDays: 30 }),
      row({ total: 2, ageDays: 31 }),
      row({ total: 4, ageDays: 60 }),
      row({ total: 8, ageDays: 90 }),
      row({ total: 16, ageDays: 91 }),
    ]);
    expect(totals.aging).toEqual({ d0_30: 1, d31_60: 6, d61_90: 8, d90plus: 16 });
    expect(totals.over60Count).toBe(2); // 90 and 91 (over 60), 60 itself is not
  });

  it('empty book is all zeros', () => {
    expect(summarizeOrderBook([])).toEqual({
      count: 0, value: 0, unbilled: 0, over60Count: 0,
      aging: { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 },
    });
  });
});
