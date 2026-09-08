import { describe, it, expect } from 'vitest';
import {
  buildMaterialLines, matchSubstrate, normalizeFilmName, summarizeLines,
  type CatalogFilm, type ShopMaterialDefaults,
} from './material-costing';

const film: CatalogFilm = {
  id: 'f1',
  name: 'IJ280',
  cost_per_sqft: 1.10,
  laminate_name: '8548G',
  laminate_cost_per_sqft: 0.60,
  premask_name: 'R-Tape 4075',
  premask_cost_per_sqft: 0.22,
  ink_cost_per_sqft: 0.35,
};
const noDefaults: ShopMaterialDefaults = { inkCostPerSqft: null, premaskCostPerSqft: null };

// A roll plan that pulled 100 ft² of roll to print 80 ft² of graphic —
// 20 ft² of scrap.
const usage = { filmLabel: 'IJ280 White', rollSqft: 100, graphicSqft: 80, linearFeet: 50 };

describe('buildMaterialLines', () => {
  it('bills film and laminate on ROLL area, premask and ink on GRAPHIC area', () => {
    const lines = buildMaterialLines({ ...usage, substrate: film, defaults: noDefaults });
    const by = Object.fromEntries(lines.map(l => [l.category, l]));
    expect(by.vinyl.quantitySqft).toBe(100);
    expect(by.laminate.quantitySqft).toBe(100);
    // The scrap the printer never inked:
    expect(by.premask.quantitySqft).toBe(80);
    expect(by.ink.quantitySqft).toBe(80);
    expect(by.vinyl.cost).toBe(110);
    expect(by.laminate.cost).toBe(60);
    expect(by.premask.cost).toBe(17.6);
    expect(by.ink.cost).toBe(28);
    expect(summarizeLines(lines)).toEqual({ total: 215.6, priced: 4, unpriced: 0 });
  });

  it('falls back to the shop default rate, then leaves the line unpriced — never $0', () => {
    const bare: CatalogFilm = { ...film, cost_per_sqft: null, ink_cost_per_sqft: null, premask_cost_per_sqft: null, premask_name: null };
    const withDefaults = buildMaterialLines({
      ...usage, substrate: bare, defaults: { inkCostPerSqft: 0.30, premaskCostPerSqft: 0.20 },
    });
    const dby = Object.fromEntries(withDefaults.map(l => [l.category, l]));
    expect(dby.ink.costSource).toBe('settings_default');
    expect(dby.premask.costSource).toBe('settings_default');
    // Film has no catalog rate and no last-logged rate: unpriced, not free.
    expect(dby.vinyl.cost).toBeNull();
    expect(dby.vinyl.costSource).toBeNull();

    const bland = buildMaterialLines({ ...usage, substrate: bare, defaults: noDefaults });
    // No ink rate anywhere → no ink line invented.
    expect(bland.find(l => l.category === 'ink')).toBeUndefined();
    expect(summarizeLines(bland).unpriced).toBeGreaterThan(0);
  });

  it('uses the legacy last-logged rate only when the catalog has none', () => {
    const bare: CatalogFilm = { ...film, cost_per_sqft: null };
    const lines = buildMaterialLines({ ...usage, substrate: bare, defaults: noDefaults, lastLoggedFilmRate: 0.95 });
    const vinyl = lines.find(l => l.category === 'vinyl')!;
    expect(vinyl.cost).toBe(95);
    expect(vinyl.costSource).toBe('last_logged');

    // Catalog wins when both exist.
    const priced = buildMaterialLines({ ...usage, substrate: film, defaults: noDefaults, lastLoggedFilmRate: 0.95 });
    expect(priced.find(l => l.category === 'vinyl')!.costSource).toBe('catalog');
  });

  it('omits laminate entirely for an unlaminated film', () => {
    const plain: CatalogFilm = { ...film, laminate_name: null, laminate_cost_per_sqft: null };
    const lines = buildMaterialLines({ ...usage, substrate: plain, defaults: noDefaults });
    expect(lines.find(l => l.category === 'laminate')).toBeUndefined();
  });

  it('still records what an unmatched film burned, with no catalog link', () => {
    const lines = buildMaterialLines({ ...usage, substrate: null, defaults: noDefaults });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ category: 'vinyl', materialName: 'IJ280 White', substrateId: null, cost: null });
  });
});

describe('matchSubstrate', () => {
  const catalog = [
    { id: 'a', name: 'IJ280' },
    { id: 'b', name: 'IJ180Cv3' },
    { id: 'c', name: '3M 40C' },
  ];

  it('matches case- and space-insensitively', () => {
    expect(matchSubstrate('  ij280 ', catalog)?.id).toBe('a');
    expect(matchSubstrate('3M   40C', catalog)?.id).toBe('c');
    expect(normalizeFilmName(' 3m  40c ')).toBe('3M 40C');
  });

  it('resolves a unique partial but refuses an ambiguous one', () => {
    expect(matchSubstrate('IJ180', catalog)?.id).toBe('b');
    // 'IJ' prefixes two films — a wrong film is worse than no link.
    expect(matchSubstrate('IJ', catalog)).toBeNull();
    expect(matchSubstrate('', catalog)).toBeNull();
    expect(matchSubstrate(null, catalog)).toBeNull();
  });
});
