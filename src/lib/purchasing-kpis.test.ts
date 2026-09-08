import { describe, it, expect } from 'vitest';
import { computePurchasingKpis, median, type ReceiptRecord, type RequestRecord } from './purchasing-kpis';

const NOW = Date.parse('2026-09-08T12:00:00Z');
const iso = (d: string) => `${d}T12:00:00.000Z`;

const req = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  id: 'r1', itemNumber: 'BRK-100', vendorName: 'Grimco',
  createdAt: iso('2026-08-01'), orderedAt: iso('2026-08-03'),
  neededBy: null, status: 'ordered', orderedPoId: 'po1', ...over,
});

describe('median', () => {
  it('is a median, not a mean — one 90-day outlier does not redefine a week', () => {
    expect(median([5, 6, 7, 90])).toBe(6.5);
    expect(median([])).toBeNull();
  });
});

describe('computePurchasingKpis', () => {
  const receipts: ReceiptRecord[] = [
    { poId: 'po1', itemNumber: 'BRK-100', receivedAt: iso('2026-08-10') },
    { poId: 'po1', itemNumber: 'brk-100', receivedAt: iso('2026-08-14') }, // later partial
  ];

  it('measures request→order and order→first-receipt, case-insensitively', () => {
    const k = computePurchasingKpis([req()], receipts, NOW);
    expect(k.medianRequestToOrderDays).toBe(2);
    // The FIRST receipt starts the clock, not the later partial.
    expect(k.medianOrderToReceiptDays).toBe(7);
  });

  it('scores needed-by only on things that actually arrived', () => {
    const k = computePurchasingKpis([
      req({ id: 'a', neededBy: iso('2026-08-15') }),           // arrived 8/10 — met
      req({ id: 'b', neededBy: iso('2026-08-05') }),           // arrived 8/10 — missed
      req({ id: 'c', neededBy: iso('2026-08-20'), orderedPoId: 'never' }), // no receipt
    ], receipts, NOW);
    expect(k.neededBySamples).toBe(2);
    expect(k.neededByHitRate).toBe(0.5);
  });

  it('ages only OPEN requests, in buckets, and tracks the oldest', () => {
    const k = computePurchasingKpis([
      req({ id: 'p1', status: 'pending', orderedAt: null, createdAt: iso('2026-09-07') }),
      req({ id: 'p2', status: 'pending', orderedAt: null, createdAt: iso('2026-08-20') }),
      req({ id: 'p3', status: 'pending', orderedAt: null, createdAt: iso('2026-06-01') }),
      req({ id: 'done' }),
    ], receipts, NOW);
    expect(k.openAging.d0_3).toBe(1);
    expect(k.openAging.d15_30).toBe(1);
    expect(k.openAging.d30plus).toBe(1);
    expect(k.oldestOpenDays).toBeGreaterThan(90);
  });

  it('reports a cancellation rate and per-vendor arrival times', () => {
    const k = computePurchasingKpis([
      req(), req({ id: 'x', status: 'cancelled', orderedAt: null, orderedPoId: null }),
    ], receipts, NOW);
    expect(k.cancelled).toBe(1);
    expect(k.cancellationRate).toBe(0.5);
    expect(k.byVendor[0]).toMatchObject({ vendor: 'Grimco', ordered: 1 });
  });

  it('discards impossible gaps rather than letting them drag a median negative', () => {
    // Receipt dated BEFORE the order — corrupt, not a zero-day delivery.
    const k = computePurchasingKpis(
      [req({ orderedAt: iso('2026-08-20') })],
      [{ poId: 'po1', itemNumber: 'BRK-100', receivedAt: iso('2026-08-10') }],
      NOW,
    );
    expect(k.medianOrderToReceiptDays).toBeNull();
    expect(k.orderToReceiptSamples).toBe(0);
  });
});
