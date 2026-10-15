import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ findItems: vi.fn(), getItemBasePrices: vi.fn() }));
vi.mock('@/lib/part-number', () => ({ fetchPartRowsCI: vi.fn() }));

import { diffWrapEstimateLines, plannedWrapEstimateLines } from './wrap-quote-estimate-lines';

const quote = {
  quote_number: 'WQ-2610-014',
  vehicle_description: '2025 Ford Transit',
  materials_total: 1562.6,
  labor_total: 1239.1,
  package_qty: 1,
  pricing_overrides: { custom_lines: [{ id: 'a', description: 'Old graphics removal', qty: 1, unit_price: 250 }] },
};

describe('plannedWrapEstimateLines', () => {
  it('writes vinyl, install, then the rep\'s own lines', () => {
    const lines = plannedWrapEstimateLines(quote);
    expect(lines.map(l => [l.item_number, l.quantity, l.unit_price, l.is_custom])).toEqual([
      ['3M Vinyl', 1, 1562.6, false],
      ['Graphics Install Labor', 1, 1239.1, false],
      [null, 1, 250, true],
    ]);
    expect(lines[0].description).toBe('Vehicle graphics — 2025 Ford Transit — WQ-2610-014');
    expect(lines[2].description).toBe('Old graphics removal');
  });

  it('only custom lines still makes lines; nothing priced makes none', () => {
    expect(plannedWrapEstimateLines({ ...quote, materials_total: 0, labor_total: 0 })).toHaveLength(1);
    expect(plannedWrapEstimateLines({ quote_number: 'WQ', materials_total: 0, labor_total: 0 })).toHaveLength(0);
  });
});

describe('diffWrapEstimateLines', () => {
  const planned = plannedWrapEstimateLines(quote);
  const asWritten = planned.map((p, i) => ({ ...p, sort_order: i }));

  it('finds nothing when the estimate still matches', () => {
    expect(diffWrapEstimateLines(planned, asWritten)).toEqual([]);
  });

  it('reports a price typed on the estimate', () => {
    const edited = asWritten.map(l => (l.item_number === '3M Vinyl' ? { ...l, unit_price: 1400 } : l));
    expect(diffWrapEstimateLines(planned, edited)).toEqual([{ summary: '3M Vinyl: $1,562.60 → $1,400.00' }]);
  });

  it('reports a renamed line, a qty change and a removed line', () => {
    const edited = [
      { ...asWritten[0], description: 'Full wrap', quantity: 2 },
      asWritten[1],
    ];
    expect(diffWrapEstimateLines(planned, edited)).toEqual([
      { summary: '3M Vinyl: description changed to "Full wrap", qty 1 → 2' },
      { summary: 'Old graphics removal was removed from the estimate' },
    ]);
  });
});
