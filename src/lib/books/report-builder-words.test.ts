import { describe, it, expect } from 'vitest';
import {
  BUILDER_BY, BUILDER_MONTHS, BUILDER_ROWS, BY_LABELS, MONTHS_LABELS, NO_PARTY, ROWS_LABELS, builderTitle, filterWords,
} from './report-builder-words';

describe("the report builder's words", () => {
  it('names a report by what it has a line and a column for', () => {
    expect(BUILDER_BY.map((by) => builderTitle(by))).toEqual([
      'Profit and loss', 'Profit and loss by month', 'Profit and loss by quarter', 'Profit and loss by year',
      'Profit and loss by division', 'Profit and loss by location',
    ]);
    expect(BUILDER_BY.map((by) => builderTitle(by, 'account'))).toEqual(BUILDER_BY.map((by) => builderTitle(by)));
    expect(builderTitle('total', 'customer')).toBe('Profit and loss by customer');
    expect(builderTitle('month', 'customer')).toBe('Profit and loss by customer and month');
    expect(builderTitle('location', 'vendor')).toBe('Profit and loss by vendor and location');
    expect(BUILDER_BY.map((by) => BY_LABELS[by])).toEqual([
      'The months altogether', 'Each month', 'Each quarter', 'Each year', 'Each division', 'Each location',
    ]);
    expect(BUILDER_ROWS.map((rows) => ROWS_LABELS[rows])).toEqual(['Each account', 'Each customer', 'Each vendor']);
    expect(NO_PARTY).toEqual({ customer: 'No customer', vendor: 'No vendor' });
  });

  it('names the months a report covers', () => {
    expect(BUILDER_MONTHS.map((m) => MONTHS_LABELS[m])).toEqual([
      'The months picked', 'Year to date', 'Last month', 'Last quarter', 'Last year', 'Last 12 months',
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
