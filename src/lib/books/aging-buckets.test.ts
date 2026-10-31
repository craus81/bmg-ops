import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ suiteqlQueryAll: vi.fn(), getAccountBalancesFromRestlet: vi.fn(), transactionUrl: vi.fn() }));

import { bucketFor } from '@/lib/financials-data';
import { BUCKETS, BUCKET_NAMES, DOCUMENT_TYPES, bucketOf, daysLate } from './aging-buckets';

describe('bucketOf', () => {
  it('ages as Financials does, day for day', () => {
    for (let days = -400; days <= 400; days += 1) expect(bucketOf(days), String(days)).toBe(bucketFor(days));
  });

  it('puts each edge in the earlier bucket: not yet due is current', () => {
    expect([-3, 0, 1, 30, 31, 60, 61, 90, 91, 680].map(bucketOf)).toEqual([
      'current', 'current', 'd1_30', 'd1_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90plus', 'd90plus',
    ]);
  });

  it('lists the buckets oldest last, each with what the pages call it', () => {
    expect(BUCKETS).toEqual(['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus']);
    expect(BUCKETS.map((b) => BUCKET_NAMES[b])).toEqual(['Current', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days']);
    expect(DOCUMENT_TYPES).toEqual({ CustInvc: 'Invoice', CustCred: 'Credit memo', VendBill: 'Bill', VendCred: 'Bill credit' });
  });
});

describe('daysLate', () => {
  it('counts whole days from a date to today, negative while not yet due', () => {
    expect(daysLate('2026-10-03', '2026-10-31')).toBe(28);
    expect(daysLate('2026-10-31', '2026-10-31')).toBe(0);
    expect(daysLate('2026-11-01', '2026-10-31')).toBe(-1);
    expect(daysLate('2026-07-10', '2026-10-31')).toBe(113);
  });

  it('counts across years, a leap day and the clocks changing', () => {
    expect(daysLate('2024-12-20', '2026-10-31')).toBe(680);
    expect(daysLate('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysLate('2026-03-01', '2026-03-31')).toBe(30);
    expect(daysLate('2026-11-01', '2026-11-30')).toBe(29);
  });

  it('gives nothing without dates it can read', () => {
    expect(daysLate(null, '2026-10-31')).toBeNull();
    expect(daysLate('', '2026-10-31')).toBeNull();
    expect(daysLate('10/03/2026', '2026-10-31')).toBeNull();
    expect(daysLate('2026-10-03T00:00:00Z', '2026-10-31')).toBeNull();
    expect(daysLate('2026-10-03', '')).toBeNull();
    expect(daysLate('2026-10-03', 'today')).toBeNull();
  });
});
