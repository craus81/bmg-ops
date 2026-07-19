import { describe, it, expect } from 'vitest';
import { normalizeItemNumber, isOpenPoStatus } from './vendor-po-sync';

// Part-number matching is the whole ballgame for vendor-PO ↔ SO readiness
// (the documents are never linked in NetSuite) — pin the normalization.
describe('normalizeItemNumber', () => {
  it('takes the last segment of sub-item ids', () => {
    expect(normalizeItemNumber('RANGER : C4-RA24-3')).toBe('C4-RA24-3');
    expect(normalizeItemNumber('A : B : C4-RA24-3')).toBe('C4-RA24-3');
  });
  it('uppercases and trims plain part numbers', () => {
    expect(normalizeItemNumber('  c4-ra24-3 ')).toBe('C4-RA24-3');
  });
  it('handles null/undefined/empty', () => {
    expect(normalizeItemNumber(null)).toBe('');
    expect(normalizeItemNumber(undefined)).toBe('');
    expect(normalizeItemNumber('')).toBe('');
  });
});

describe('isOpenPoStatus', () => {
  it('treats pending/partially received as open', () => {
    expect(isOpenPoStatus('A')).toBe(true);
    expect(isOpenPoStatus('B')).toBe(true);
    expect(isOpenPoStatus('E')).toBe(true);
  });
  it('treats fully billed / closed / cancelled as done', () => {
    expect(isOpenPoStatus('F')).toBe(false);
    expect(isOpenPoStatus('G')).toBe(false);
    expect(isOpenPoStatus('H')).toBe(false);
    expect(isOpenPoStatus('f')).toBe(false);
  });
  it('unknown or missing status counts as open (never hide inventory)', () => {
    expect(isOpenPoStatus(null)).toBe(true);
    expect(isOpenPoStatus('Z')).toBe(true);
  });
});
