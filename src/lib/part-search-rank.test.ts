import { describe, it, expect } from 'vitest';
import { partMatchTier, rankPartResults } from './part-search-rank';

describe('partMatchTier', () => {
  it('ranks exact, starts-with, piece, contains, then text-only', () => {
    expect(partMatchTier('UP-3000', '3000')).toBe(2);
    expect(partMatchTier('3000', '3000')).toBe(0);
    expect(partMatchTier('3000-SD', '3000')).toBe(1);
    expect(partMatchTier('UP12/3000SD-CG', '3000')).toBe(2);
    expect(partMatchTier('AB13000', '3000')).toBe(3);
    expect(partMatchTier('HM-100', '3000')).toBe(4);
  });

  it('ignores dashes in the search', () => {
    expect(partMatchTier('UP12/3000SD-CG', 'up12/3000sd-cg')).toBe(0);
    expect(partMatchTier('UP12/3000SD-CG', 'up123000')).toBe(1);
  });
});

describe('rankPartResults', () => {
  it('puts part number matches above description matches and drops duplicates', () => {
    const rows = [
      { id: 'a', item_number: 'HM-100' },        // description said "3000 lb"
      { id: 'b', item_number: 'UP12/3000SD-CG' },
      { id: 'c', item_number: '3000' },
      { id: 'b', item_number: 'UP12/3000SD-CG' },
      { id: 'd', item_number: 'AB13000' },
    ];
    expect(rankPartResults(rows, '3000').map(r => r.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});
