import { describe, it, expect } from 'vitest';
import { computeCatalogHealth, coverageTone, CATALOG_ATTRIBUTES, type CatalogPart } from './catalog-health';

const part = (over: Partial<CatalogPart>): CatalogPart => ({
  id: over.item_number || 'id', item_number: 'P-1',
  netsuite_id: '900', vendor: 'Adrian Steel', product_category_id: 'cat-1',
  image_path: 'photos/p1.jpg', labor_hours: 1.5, width_in: 20,
  is_taxable: true, product_url: 'https://example.com/p1',
  ...over,
});

const attr = (h: ReturnType<typeof computeCatalogHealth>, key: string) =>
  h.attributes.find(a => a.key === key)!;

describe('computeCatalogHealth', () => {
  it('reports whole-catalog and in-demand coverage separately', () => {
    // Three parts have a photo, but the only part anybody is buying does not.
    const parts = [
      part({ item_number: 'HOT-1', image_path: null }),
      part({ item_number: 'COLD-1' }),
      part({ item_number: 'COLD-2' }),
      part({ item_number: 'COLD-3' }),
    ];
    const health = computeCatalogHealth(parts, new Set(['HOT-1']));
    const photo = attr(health, 'photo');
    expect(photo.pct).toBe(75);      // catalog-wide: looks fine
    expect(photo.hotPct).toBe(0);    // where it matters: nothing
    expect(photo.hotTotal).toBe(1);
  });

  it('never counts a NULL as an answer for labor or taxability', () => {
    // 0 hours means "no labor charged" and false means "confirmed
    // non-taxable" — both are answers. NULL is the gap.
    const parts = [
      part({ item_number: 'A', labor_hours: 0, is_taxable: false }),
      part({ item_number: 'B', labor_hours: null, is_taxable: null }),
    ];
    const health = computeCatalogHealth(parts, new Set());
    expect(attr(health, 'labor_hours').filled).toBe(1);
    expect(attr(health, 'taxability').filled).toBe(1);
  });

  it('puts in-demand parts at the front of the fix-it worklist', () => {
    const parts = [
      part({ item_number: 'COLD-1', product_category_id: null }),
      part({ item_number: 'COLD-2', product_category_id: null }),
      part({ item_number: 'HOT-1', product_category_id: null }),
    ];
    const health = computeCatalogHealth(parts, new Set(['HOT-1']));
    expect(attr(health, 'category').worklist[0].item_number).toBe('HOT-1');
  });

  it('names in-demand items the catalog has no row for at all', () => {
    const health = computeCatalogHealth(
      [part({ item_number: 'P-1' })],
      new Set(['P-1', 'GHOST-9']),
    );
    // A part being bought that isn't in the catalog can't appear in any
    // bar below, so it gets said out loud instead.
    expect(health.uncatalogued).toEqual(['GHOST-9']);
  });

  it('leads with the attribute in the worst shape where it counts', () => {
    const parts = [
      part({ item_number: 'HOT-1', image_path: null, product_url: null }),
      part({ item_number: 'HOT-2', image_path: null }),
    ];
    const health = computeCatalogHealth(parts, new Set(['HOT-1', 'HOT-2']));
    expect(health.attributes[0].key).toBe('photo');   // 0% vs 50%
  });

  it('reports null rather than 0% when there is nothing to measure', () => {
    const health = computeCatalogHealth([], new Set());
    expect(attr(health, 'photo').pct).toBeNull();
    expect(attr(health, 'photo').hotPct).toBeNull();
    expect(coverageTone(null)).toBe('none');
  });

  it('gives every attribute a reason a gap costs something', () => {
    for (const a of CATALOG_ATTRIBUTES) {
      expect(a.why.length).toBeGreaterThan(10);
      expect(a.fixHint.length).toBeGreaterThan(10);
    }
  });
});

describe('coverageTone', () => {
  it('does not paint a nearly-complete catalog red', () => {
    expect(coverageTone(95)).toBe('good');
    expect(coverageTone(88)).toBe('warn');
    expect(coverageTone(40)).toBe('bad');
  });
});
