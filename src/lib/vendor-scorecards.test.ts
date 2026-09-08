import { describe, it, expect } from 'vitest';
import { summarizeVendors, vendorChipText, type VendorPoFacts, type VendorStats } from './vendor-scorecards';

const po = (poId: string, vendor: string, trandate: string, total = 1000): VendorPoFacts =>
  ({ poId, vendor, tranid: `PO-${poId}`, trandate, total });

describe('summarizeVendors', () => {
  it('median lead (PO date → first receipt), promise-vs-actual (first ETA → final receipt), slips, short lines', () => {
    const [meyer] = summarizeVendors(
      [po('a', 'Meyer', '2026-08-01', 500), po('b', 'Meyer', '2026-08-10', 1500)],
      [
        { poId: 'a', receivedAt: '2026-08-06T15:00:00Z' }, // lead 5
        { poId: 'a', receivedAt: '2026-08-09T15:00:00Z' }, // final receipt day 8/9
        { poId: 'b', receivedAt: '2026-08-21T15:00:00Z' }, // lead 11
      ],
      [
        { poId: 'a', etaDate: '2026-08-05', previousEta: null, createdAt: '2026-08-02T00:00:00Z' }, // first promise
        { poId: 'a', etaDate: '2026-08-08', previousEta: '2026-08-05', createdAt: '2026-08-04T00:00:00Z' }, // slip +3
      ],
      [
        { poId: 'a', quantity: 10, quantityReceived: 8 }, // short
        { poId: 'a', quantity: 5, quantityReceived: 5 },
        { poId: 'b', quantity: 2, quantityReceived: 0 }, // not yet received — not counted
      ],
    );
    expect(meyer.vendor).toBe('Meyer');
    expect(meyer).toMatchObject({ poCount: 2, spend: 2000, medianLeadDays: 8, leadSamples: 2 });
    // First ETA 8/05 vs final receipt 8/09 → 4 days late.
    expect(meyer).toMatchObject({ avgPromiseMissDays: 4, promiseSamples: 1 });
    expect(meyer).toMatchObject({ slipCount: 1, avgSlipDays: 3, etaEvents: 2 });
    expect(meyer).toMatchObject({ shortShipLines: 1, receivedLines: 2 });
  });

  it('no receipts and no promises → nulls, never zeros', () => {
    const [v] = summarizeVendors([po('a', 'Ranger', '2026-08-01')], [], [], []);
    expect(v).toMatchObject({
      medianLeadDays: null, leadSamples: 0, avgPromiseMissDays: null,
      promiseSamples: 0, avgSlipDays: null, receivedLines: 0,
    });
  });
});

describe('vendorChipText', () => {
  const base: VendorStats = {
    vendor: 'Meyer', poCount: 4, spend: 9000, medianLeadDays: 8, leadSamples: 3,
    avgPromiseMissDays: null, promiseSamples: 0, slipCount: 0, etaEvents: 0,
    avgSlipDays: null, shortShipLines: 0, receivedLines: 5,
  };
  it('promise miss leads when known; lead time stands in otherwise; null when nothing', () => {
    expect(vendorChipText({ ...base, avgPromiseMissDays: 8.2, promiseSamples: 3, slipCount: 2, shortShipLines: 1 }))
      .toBe('avg 8.2d late vs promise · 2 ETA slips · 1 short line');
    expect(vendorChipText(base)).toBe('~8d lead');
    expect(vendorChipText({ ...base, avgPromiseMissDays: 0.2, promiseSamples: 2 })).toBe('on promise');
    expect(vendorChipText({ ...base, medianLeadDays: null, leadSamples: 0 })).toBe(null);
  });
});
