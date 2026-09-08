import { describe, it, expect } from 'vitest';
import { buildCostHistory, computeDrift, staleCostWorklist, type Buy } from './part-cost-book';

const buy = (over: Partial<Buy> = {}): Buy => ({
  itemNumber: 'BRK-100', poTranid: 'PO1', vendorName: 'Grimco',
  trandate: '2026-01-01', quantity: 10, rate: 5, ...over,
});

describe('buildCostHistory', () => {
  it('orders buys oldest first and reports first/last/min/max', () => {
    const h = buildCostHistory('BRK-100', [
      buy({ trandate: '2026-03-01', rate: 7 }),
      buy({ trandate: '2026-01-01', rate: 5 }),
      buy({ trandate: '2026-02-01', rate: 6, vendorName: 'Fellers' }),
    ]);
    expect(h.firstRate).toBe(5);
    expect(h.lastRate).toBe(7);
    expect(h.minRate).toBe(5);
    expect(h.maxRate).toBe(7);
    expect(h.buyCount).toBe(3);
  });

  it('weights the average by quantity so one unit cannot outweigh a pallet', () => {
    const h = buildCostHistory('BRK-100', [
      buy({ quantity: 1, rate: 100 }),
      buy({ quantity: 99, rate: 1, trandate: '2026-02-01' }),
    ]);
    // Mean of the rates would be 50.5; the truth is ~1.99.
    expect(h.weightedAvgRate).toBeCloseTo(1.99, 2);
  });

  it('drops unusable rows and survives a part with no real buys', () => {
    const h = buildCostHistory('BRK-100', [
      buy({ rate: 0 }), buy({ quantity: 0 }), buy({ rate: NaN }),
    ]);
    expect(h).toMatchObject({ buyCount: 0, lastRate: null, weightedAvgRate: null });
  });
});

describe('computeDrift', () => {
  const history = buildCostHistory('BRK-100', [buy({ rate: 12, trandate: '2026-05-01' })]);

  it('flags material drift and keeps the sign — positive means we now pay MORE', () => {
    const d = computeDrift(history, 10);
    expect(d.driftPct).toBe(20);
    expect(d.severity).toBe('material');

    const down = computeDrift(history, 15);
    expect(down.driftPct).toBe(-20);
    expect(down.severity).toBe('material');
  });

  it('grades minor drift separately and stays quiet inside the band', () => {
    // lastRate 12 against a catalog of 11 is +9.1% — inside the minor band.
    expect(computeDrift(history, 11).severity).toBe('minor');
    // 12 against 11.6 is +3.4% — under the 5% floor, so nothing is said.
    expect(computeDrift(history, 11.6).severity).toBe('none');
    expect(computeDrift(buildCostHistory('X', [buy({ rate: 10.4 })]), 10).severity).toBe('none');
  });

  it('treats an unset catalog price as UNKNOWN, not infinite drift', () => {
    expect(computeDrift(history, null)).toMatchObject({ driftPct: null, severity: 'none', catalogPrice: null });
    expect(computeDrift(history, 0)).toMatchObject({ driftPct: null, severity: 'none' });
  });

  it('respects a minimum-buys threshold before calling anything drift', () => {
    expect(computeDrift(history, 10, { minBuys: 3 }).severity).toBe('none');
  });
});

describe('staleCostWorklist', () => {
  it('puts material drift first, then the biggest magnitude', () => {
    const h = (rate: number) => buildCostHistory('P', [buy({ rate })]);
    const list = staleCostWorklist([
      computeDrift(h(10.6), 10),          // minor, +6%
      computeDrift(h(13), 10),            // material, +30%
      computeDrift(h(10), 10),            // none — filtered out
      computeDrift(h(8), 10),             // material, -20%
    ]);
    expect(list).toHaveLength(3);
    expect(list[0].driftPct).toBe(30);
    expect(list[1].driftPct).toBe(-20);
    expect(list[2].severity).toBe('minor');
  });
});
