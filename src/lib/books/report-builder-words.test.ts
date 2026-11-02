import { describe, it, expect } from 'vitest';
import { BUILDER_BY, BY_LABELS, builderTitle, filterWords } from './report-builder-words';

describe("the report builder's words", () => {
  it('names a report by what it has a column for', () => {
    expect(BUILDER_BY.map(builderTitle)).toEqual([
      'Profit and loss', 'Profit and loss by month', 'Profit and loss by quarter', 'Profit and loss by year',
      'Profit and loss by division', 'Profit and loss by location',
    ]);
    expect(BUILDER_BY.map((by) => BY_LABELS[by])).toEqual([
      'The months altogether', 'Each month', 'Each quarter', 'Each year', 'Each division', 'Each location',
    ]);
  });

  it('says what the filters keep, a line with no division or location among them', () => {
    const graphics = { key: 'graphics', label: 'Graphics' };
    const kc = { key: '3', label: 'Kansas City' };
    const none = { key: 'none', label: 'Not split' };
    const nowhere = { key: 'none', label: 'No location' };
    expect(filterWords(null, null)).toBe('');
    expect(filterWords(graphics, null)).toBe('Only Graphics lines.');
    expect(filterWords(null, kc)).toBe('Only lines at Kansas City.');
    expect(filterWords(graphics, kc)).toBe('Only Graphics lines at Kansas City.');
    expect(filterWords(none, null)).toBe('Only lines not split by division.');
    expect(filterWords(null, nowhere)).toBe('Only lines with no location.');
    expect(filterWords(none, nowhere)).toBe('Only lines not split by division with no location.');
  });
});
