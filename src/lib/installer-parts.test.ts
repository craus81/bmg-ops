import { describe, expect, it } from 'vitest';
import { matchesPartSearch } from './installer-parts';

const part = { item_number: 'MRK-CONSOLE-120', display_name: 'Havis console', description: '2020+ Explorer' };

describe('matchesPartSearch', () => {
  it('matches everything when nothing is typed', () => {
    expect(matchesPartSearch(part, '  ')).toBe(true);
  });
  it('matches words across number, name and description in any case', () => {
    expect(matchesPartSearch(part, 'havis explorer')).toBe(true);
    expect(matchesPartSearch(part, 'console-120')).toBe(true);
  });
  it('needs every word', () => {
    expect(matchesPartSearch(part, 'havis lightbar')).toBe(false);
  });
  it('copes with a part that has no name or description', () => {
    expect(matchesPartSearch({ item_number: 'FA-KIT-25', display_name: null, description: null }, 'kit')).toBe(true);
  });
});
