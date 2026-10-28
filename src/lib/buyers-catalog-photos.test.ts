import { describe, it, expect } from 'vitest';
import { matchCatalogPhotos, type CatalogEntry, type CatalogPart } from './buyers-catalog-photos';

const catalog: Record<string, CatalogEntry> = {
  '1702700': ['aaa', 13, 1],
  '1702703': ['aaa', 13, 0],
  '1705103': ['bbb', 25, 0],
  'HV020': ['ccc', 424, 1],
  '5624110': ['ddd', 222, 1],
};
const part = (id: string, item_number: string, extra: Partial<CatalogPart> = {}): CatalogPart =>
  ({ id, item_number, is_active: true, image_path: null, ...extra });

describe('matchCatalogPhotos', () => {
  it('matches exact and dashless part numbers and labels the photo kind', () => {
    const m = matchCatalogPhotos([part('1', '1702700'), part('2', '1702-703'), part('3', 'hv020')], catalog);
    expect(m.map(x => [x.itemNumber, x.photo, x.exactPhoto, x.closeNumber])).toEqual([
      ['1702-703', 'aaa', false, false],
      ['1702700', 'aaa', true, false],
      ['hv020', 'ccc', true, false],
    ]);
  });

  it('takes a unique prefix match but flags it as a close number', () => {
    const [m] = matchCatalogPhotos([part('1', 'BP-1705103')], catalog);
    expect(m).toMatchObject({ itemNumber: 'BP-1705103', catalogNumber: '1705103', closeNumber: true });
  });

  it('prefers an exact number over a close one for the same part', () => {
    const m = matchCatalogPhotos([part('1', '5624110')], { ...catalog, '624110': ['zzz', 1, 1] });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ catalogNumber: '5624110', closeNumber: false });
  });

  it('skips inactive parts and reports parts that already have a photo', () => {
    const m = matchCatalogPhotos([
      part('1', '1702700', { is_active: false }),
      part('2', 'HV020', { image_path: 'parts/2/x.jpg' }),
    ], catalog);
    expect(m).toEqual([expect.objectContaining({ partId: '2', hasPhoto: true })]);
  });
});
