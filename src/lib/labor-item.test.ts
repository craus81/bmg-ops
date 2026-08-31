import { describe, it, expect } from 'vitest';
import { rankLaborItems } from './labor-item';

/**
 * The ranking is what makes one labor item THE labor item. Both historical
 * failures are asserted here: first-match nondeterminism (Round 1) and the
 * narrow LABOR-prefix match that found nothing in this account and dropped
 * labor off every pushed estimate.
 */
describe('rankLaborItems', () => {
  it('prefers the item named exactly LABOR', () => {
    const ranked = rankLaborItems([
      { id: 5, itemid: 'Graphics Install Labor' },
      { id: 9, itemid: 'LABOR' },
      { id: 7, itemid: 'Shop Labor' },
    ]);
    expect(ranked[0].id).toBe(9);
  });

  it('finds a labor item whose name does not start with LABOR', () => {
    const ranked = rankLaborItems([
      { id: 3, itemid: 'BMG-Install Labor' },
      { id: 4, itemid: '3M Vinyl' },
    ]);
    expect(ranked.map(r => r.id)).toEqual([3]);
  });

  it('ranks shop labor above a department-specific labor item', () => {
    const ranked = rankLaborItems([
      { id: 5, itemid: 'Graphics Install Labor' },
      { id: 7, itemid: 'Shop Labor' },
    ]);
    expect(ranked.map(r => r.id)).toEqual([7, 5]);
  });

  it('is deterministic regardless of the order NetSuite returns rows in', () => {
    const rows = [
      { id: 1, itemid: 'Wrap Labor' },
      { id: 2, itemid: 'Install Labor' },
      { id: 3, itemid: 'LABOR-SHOP' },
    ];
    const a = rankLaborItems(rows).map(r => r.id);
    const b = rankLaborItems([...rows].reverse()).map(r => r.id);
    expect(a).toEqual(b);
    expect(a[0]).toBe(3);
  });

  it('drops items that are not labor at all', () => {
    expect(rankLaborItems([{ id: 1, itemid: 'FS-CUSTOM' }, { id: 2, itemid: null }])).toEqual([]);
  });
});
