import { describe, it, expect } from 'vitest';
import { proposeDisplayName, isRealNetsuiteId, DisplayNamePart } from './part-display-names';

const part = (over: Partial<DisplayNamePart>): DisplayNamePart => ({
  id: 'p1', netsuite_id: '501', item_number: 'CC600', display_name: 'CC600',
  description: null, graphic_package: null, ...over,
});

describe('proposeDisplayName', () => {
  it('uses the description when the name just repeats the part number', () => {
    const p = proposeDisplayName(part({ description: 'PVC Conduit Carrier with 6" metal caps' }));
    expect(p).toMatchObject({ current: 'CC600', proposed: 'PVC Conduit Carrier with 6" metal caps', source: 'description' });
  });

  it('prefers the graphic package over the description', () => {
    const p = proposeDisplayName(part({
      item_number: '06N642', display_name: '06N642',
      graphic_package: 'Install Sherwin Williams LR Decals', description: 'Decal set',
    }));
    expect(p).toMatchObject({ proposed: 'Install Sherwin Williams LR Decals', source: 'graphic_package' });
  });

  it('fills a blank name', () => {
    expect(proposeDisplayName(part({ display_name: null, description: 'Bin' }))?.proposed).toBe('Bin');
    expect(proposeDisplayName(part({ display_name: '  ', description: 'Bin' }))?.proposed).toBe('Bin');
  });

  it('matches the part number ignoring case and spaces', () => {
    expect(proposeDisplayName(part({ display_name: ' cc600 ', description: 'Bin' }))?.proposed).toBe('Bin');
  });

  it('keeps a name someone already typed', () => {
    expect(proposeDisplayName(part({ display_name: 'Conduit carrier', description: 'Other words' }))).toBeNull();
  });

  it('skips a part with neither field', () => {
    expect(proposeDisplayName(part({ description: '  ', graphic_package: '' }))).toBeNull();
  });

  it('skips when the only text is the part number again', () => {
    expect(proposeDisplayName(part({ description: 'CC600' }))).toBeNull();
  });

  it('flattens a multi-line description to one line', () => {
    expect(proposeDisplayName(part({ description: 'PVC carrier\n  with caps\t' }))?.proposed).toBe('PVC carrier with caps');
  });
});

describe('isRealNetsuiteId', () => {
  it('treats only numeric NetSuite ids as real', () => {
    expect(isRealNetsuiteId('501')).toBe(true);
    expect(isRealNetsuiteId(null)).toBe(false);
    expect(isRealNetsuiteId('LOCAL-12')).toBe(false);
    expect(isRealNetsuiteId('bmg-9')).toBe(false);
  });
});
