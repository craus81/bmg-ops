import { describe, it, expect, vi } from 'vitest';
import { partNumberPattern, canonicalizePartNumber } from './part-number';

describe('partNumberPattern', () => {
  it('passes ordinary part numbers through untouched', () => {
    expect(partNumberPattern('06U166')).toBe('06U166');
    expect(partNumberPattern('9950-4708-KIT')).toBe('9950-4708-KIT');
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(partNumberPattern('06_166')).toBe('06\\_166');
    expect(partNumberPattern('50%KIT')).toBe('50\\%KIT');
    expect(partNumberPattern('A\\B')).toBe('A\\\\B');
  });
});

describe('canonicalizePartNumber', () => {
  const serviceReturning = (rows: { item_number: string }[]) => {
    const query: any = {
      select: vi.fn(() => query),
      ilike: vi.fn(() => query),
      limit: vi.fn(() => Promise.resolve({ data: rows })),
    };
    return { from: vi.fn(() => query) } as any;
  };

  it('resolves a hand-typed casing to the catalog casing', async () => {
    // The reported bug: an installer typed 06u166 and every exact-match
    // consumer then missed the catalog's 06U166.
    const service = serviceReturning([{ item_number: '06U166' }]);
    expect(await canonicalizePartNumber(service, '06u166')).toBe('06U166');
  });

  it('keeps free text (custom jobs) as typed when the catalog has no match', async () => {
    const service = serviceReturning([]);
    expect(await canonicalizePartNumber(service, 'Install shelving')).toBe('Install shelving');
  });

  it('trims, and returns null for empty input', async () => {
    const service = serviceReturning([]);
    expect(await canonicalizePartNumber(service, '  ABC1 ')).toBe('ABC1');
    expect(await canonicalizePartNumber(service, '   ')).toBe(null);
    expect(await canonicalizePartNumber(service, null)).toBe(null);
  });
});
