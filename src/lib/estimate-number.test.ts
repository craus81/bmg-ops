import { describe, it, expect } from 'vitest';
import { estimateHeadlineNumber, estimateAltNumber, estimateNumberMatches } from './estimate-number';

const fsOnly = { estimate_number: 'EST-2608-041', netsuite_estimate_number: null };
const pushed = { estimate_number: 'EST-2608-041', netsuite_estimate_number: '12345' };

describe('estimateHeadlineNumber', () => {
  it('shows the FleetSuite number until the estimate is pushed', () => {
    expect(estimateHeadlineNumber(fsOnly)).toBe('EST-2608-041');
  });

  it('shows the NetSuite number once it exists', () => {
    expect(estimateHeadlineNumber(pushed)).toBe('12345');
  });

  it('ignores a blank/whitespace NetSuite number rather than showing nothing', () => {
    expect(estimateHeadlineNumber({ estimate_number: 'EST-1', netsuite_estimate_number: '  ' })).toBe('EST-1');
  });

  it('is empty-safe for missing rows', () => {
    expect(estimateHeadlineNumber(null)).toBe('');
    expect(estimateHeadlineNumber({})).toBe('');
  });
});

describe('estimateAltNumber', () => {
  it('is null when there is only one number', () => {
    expect(estimateAltNumber(fsOnly)).toBeNull();
  });

  it('keeps the FleetSuite number visible once NetSuite takes the headline', () => {
    expect(estimateAltNumber(pushed)).toBe('EST-2608-041');
  });

  it('does not repeat an identical number', () => {
    expect(estimateAltNumber({ estimate_number: 'EST-1', netsuite_estimate_number: 'EST-1' })).toBeNull();
  });
});

describe('estimateNumberMatches', () => {
  it('matches either number, case-insensitively', () => {
    expect(estimateNumberMatches(pushed, 'est-2608')).toBe(true);
    expect(estimateNumberMatches(pushed, '1234')).toBe(true);
    expect(estimateNumberMatches(pushed, 'nope')).toBe(false);
  });

  it('treats an empty query as a match so callers can filter unconditionally', () => {
    expect(estimateNumberMatches(fsOnly, '   ')).toBe(true);
  });
});
