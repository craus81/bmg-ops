import { describe, it, expect } from 'vitest';
import { splitPartNumbers, partsToSplit } from './scan-part-split';

describe('splitPartNumbers', () => {
  it('splits a typed "A/B" into its parts, in order', () => {
    expect(splitPartNumbers('0602S029/06S646')).toEqual(['0602S029', '06S646']);
  });
  it('trims spaces and drops empty pieces', () => {
    expect(splitPartNumbers(' 06U183 / 06S646 / ')).toEqual(['06U183', '06S646']);
  });
  it('collapses a repeat typed in another casing', () => {
    expect(splitPartNumbers('06s646/06S646')).toEqual(['06s646']);
  });
  it('returns one part, or none, without a slash', () => {
    expect(splitPartNumbers('Uhaul Regular')).toEqual(['Uhaul Regular']);
    expect(splitPartNumbers('')).toEqual([]);
    expect(splitPartNumbers(null)).toEqual([]);
  });
});

describe('partsToSplit', () => {
  it('splits two parts', () => {
    expect(partsToSplit('0602S029/06S646')).toEqual(['0602S029', '06S646']);
  });
  it('leaves a single part alone', () => {
    expect(partsToSplit('06S646')).toBeNull();
    expect(partsToSplit('06S646/')).toBeNull();
  });
  it('never splits a catalog item whose own number has a slash', () => {
    expect(partsToSplit('AB-1/2', ['ab-1/2', 'X'])).toBeNull();
    expect(partsToSplit('0602S029/06S646', ['0602S029', '06S646'])).toEqual(['0602S029', '06S646']);
  });
});
