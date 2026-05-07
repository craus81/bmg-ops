import { describe, it, expect } from 'vitest';
import {
  safeIntId,
  safeLikeTerm,
  safeStringLiteral,
  safeIsoDate,
  SqlSafeError,
} from './sql-safe';

describe('safeIntId', () => {
  it('accepts a positive integer string', () => {
    expect(safeIntId('12345')).toBe('12345');
  });

  it('trims whitespace', () => {
    expect(safeIntId('  42  ')).toBe('42');
  });

  it('accepts numeric input', () => {
    expect(safeIntId(7)).toBe('7');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['negative', '-1'],
    ['decimal', '1.5'],
    ['scientific', '1e5'],
    ['SQL fragment', "1; DROP TABLE customer"],
    ['quote injection', "1' OR '1'='1"],
    ['huge number', '1234567890123456'],
    ['letters', 'abc'],
    ['mixed', '12a'],
  ])('rejects %s', (_label, input) => {
    expect(() => safeIntId(input)).toThrow(SqlSafeError);
  });
});

describe('safeLikeTerm', () => {
  it('escapes single quotes', () => {
    expect(safeLikeTerm("O'Brien")).toBe("O''Brien");
  });

  it('escapes backslashes', () => {
    expect(safeLikeTerm('a\\b')).toBe('a\\\\b');
  });

  it('escapes LIKE wildcards', () => {
    expect(safeLikeTerm('100%')).toBe('100\\%');
    expect(safeLikeTerm('a_b')).toBe('a\\_b');
  });

  it('rejects empty input', () => {
    expect(() => safeLikeTerm('')).toThrow(SqlSafeError);
    expect(() => safeLikeTerm('   ')).toThrow(SqlSafeError);
  });

  it('enforces max length', () => {
    expect(() => safeLikeTerm('a'.repeat(81))).toThrow(SqlSafeError);
    expect(safeLikeTerm('a'.repeat(80))).toBe('a'.repeat(80));
  });

  it('blocks classic injection payload from widening match', () => {
    // The single quote and the ESCAPE-aware caller make this benign.
    const out = safeLikeTerm("' OR 1=1 --");
    expect(out).toBe("'' OR 1=1 --");
  });
});

describe('safeStringLiteral', () => {
  it('escapes single quotes and backslashes but not LIKE wildcards', () => {
    expect(safeStringLiteral("a%b'c\\d")).toBe("a%b''c\\\\d");
  });

  it('rejects empty input', () => {
    expect(() => safeStringLiteral('')).toThrow(SqlSafeError);
  });

  it('enforces max length', () => {
    expect(() => safeStringLiteral('a'.repeat(121))).toThrow(SqlSafeError);
  });
});

describe('safeIsoDate', () => {
  it('accepts a valid YYYY-MM-DD date', () => {
    expect(safeIsoDate('2025-01-15')).toBe('2025-01-15');
  });

  it.each([
    '2025-1-15',
    '01-15-2025',
    '2025/01/15',
    "2025-01-15' OR 1=1",
    '',
    'tomorrow',
  ])('rejects %s', (input) => {
    expect(() => safeIsoDate(input)).toThrow(SqlSafeError);
  });
});
