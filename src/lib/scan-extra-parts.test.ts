import { describe, it, expect } from 'vitest';
import { addExtraParts, withExtraParts } from './scan-extra-parts';

const catalog = [
  { item_number: '06S646', display_name: 'Unit # decal set 646', billable_customer: 'Masterack' },
  { item_number: '0602S029', display_name: 'Masterack decal kit', billable_customer: 'Masterack' },
  { item_number: 'AB/CD', display_name: 'Part with a slash in it' },
];

describe('addExtraParts', () => {
  it('adds a typed part, using the catalog spelling', () => {
    expect(addExtraParts([], '06s646', { catalog })).toEqual({ parts: ['06S646'], error: null });
  });
  it('keeps a number the catalog does not have, as typed', () => {
    expect(addExtraParts(['06S646'], ' 06X112 ', { catalog }).parts).toEqual(['06S646', '06X112']);
  });
  it('splits "A/B" into two parts', () => {
    expect(addExtraParts([], '06S646/06S647', { catalog }).parts).toEqual(['06S646', '06S647']);
  });
  it('does not split a catalog item whose own number has a slash', () => {
    expect(addExtraParts([], 'ab/cd', { catalog }).parts).toEqual(['AB/CD']);
  });
  it('skips parts already listed or already in the shift', () => {
    expect(addExtraParts(['06S646'], '06S646/0602s029', { catalog, baseParts: ['0602S029'] }).parts).toEqual(['06S646']);
  });
  it('refuses the Verizon RFID part and leaves the list alone', () => {
    const r = addExtraParts(['06S646'], '06CS901033', { catalog });
    expect(r.parts).toEqual(['06S646']);
    expect(r.error).toMatch(/RFID/);
  });
  it('ignores blank input', () => {
    expect(addExtraParts(['06S646'], '  ', { catalog }).parts).toEqual(['06S646']);
  });
});

describe('withExtraParts', () => {
  const base = [{ partNumber: '0602S029', partDesc: 'Masterack decal kit', billable: 'Masterack' }];
  it('adds one line per extra part after the shift parts', () => {
    expect(withExtraParts(base, ['06S646', '06X112'], catalog, 'Fallback')).toEqual([
      base[0],
      { partNumber: '06S646', partDesc: 'Unit # decal set 646', billable: 'Masterack' },
      { partNumber: '06X112', partDesc: '06X112', billable: 'Fallback' },
    ]);
  });
  it('never saves the same part twice for one vehicle', () => {
    expect(withExtraParts(base, ['0602s029'], catalog, null)).toEqual(base);
  });
  it('returns the shift parts unchanged with no extras', () => {
    expect(withExtraParts(base, [], catalog, null)).toEqual(base);
  });
});
